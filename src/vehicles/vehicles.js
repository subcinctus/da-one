// Vehicles system (ARCHITECTURE.md §Vehicles): spawning/removal, arcade physics orchestration, player driving,
// enter/exit (F) + carjacking, collisions with blocks / vehicles / people, damage -> smoke -> fire -> explosion,
// water, lights, sirens, engine audio, skid marks, parked cars streamed around the player, debug helpers.
// Street props (lamp posts, street-tree trunks, hedges, glass) snap when a car hits them hard enough.
//
// Per-vehicle extras beyond the contract:
//   vehicle.speedScale  top-speed multiplier (number, default 1, meaningful 1..1.35). Car physics scales the drive
//                       force by it and the aero drag by 1/speedScale^2, so maxSpeed * speedScale is reachable.
//                       Written only by the police AI (catch-up); reset to 1 whenever the player takes a vehicle.
import * as THREE from 'three';
import { VEHICLE_TYPES, VEHICLE_TYPE_IDS, parkedTypeForTag, gearboxRpm } from './types.js';
import { Vehicle } from './vehicle.js';
import { stepCar, stepHeli, collidePair, pointInVehicle, heliAutopilot, sampleGround } from './physics.js';
import { materials } from './models.js';
import { Humanoid, LOOKS } from '../entities/humanoid.js';
import { boxCollides } from '../core/physics.js';
import { clamp, damp } from '../core/math.js';
import { WORLD } from '../core/config.js';
import { BLOCKS } from '../world/blocks.js';

export { VEHICLE_TYPES, VEHICLE_TYPE_IDS };

const PARK_MAX = 18;          // parked cars kept around the player
const PARK_RADIUS = 120;      // spawn parked cars at spots within this distance
const DESPAWN_RADIUS = 180;   // remove unowned vehicles beyond this
const SIM_RADIUS = 210;       // vehicles farther than this from the player freeze (owners despawn them)
const SKID_MAX = 700;
const ENTER_REACH = 2.5;      // metres from the body to the player (or 3.5 m from the centre)

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _ey = new THREE.Vector3(0, 1, 0);
const _sc = new THREE.Vector3();
const _pt = { nx: 0, nz: 0, pen: 0 };

// breakable street props: 1 = soft (glass / hedge / leaves: breaks in a car-sized patch), 2 = pole material (only
// when it is a free-standing column: lamp posts, tree trunks), 3 = lamp head (goes with its pole)
const PROP = new Uint8Array(256);
for (const d of BLOCKS) {
  if (!d) continue;
  if (d.key === 'GLASS' || d.key === 'HEDGE' || d.key === 'LEAVES' || d.key === 'PALM_LEAVES') PROP[d.id] = 1;
  else if (d.key === 'METAL' || d.key === 'LOG' || d.key === 'PALM_LOG') PROP[d.id] = 2;
  else if (d.key === 'LAMP') PROP[d.id] = 3;
}
const _brk = [];

export class Vehicles {
  constructor(game) {
    this.game = game;
    /** All live vehicles. */
    this.list = [];
    this._player = null;
    this._lastPlayerVehicle = null;
    this._spots = new Map();        // parking spot index -> vehicle
    this._padHeli = null;
    this._streamT = 0;
    this._engines = new Map();      // AI vehicle -> engine handle
    this._engineT = 0;
    this._pEngine = null;
    this._screech = null;
    this._horn = null;
    this._sirens = new Map();       // player-toggled sirens: vehicle -> handle
    this._alarms = new Map();       // vehicle -> alarm loop handle
    this._fireLoops = new Map();    // vehicle -> fire loop handle
    this._riders = new Map();       // bike -> Humanoid
    this._hitCD = new Map();        // entity -> next allowed vehicle hit time
    this._blasts = [];
    this._sawBlast = false;
    this._contact = { x: 0, z: 0, y: 0, nx: 0, nz: 0 };
    this._entOut = [];
    this._enterLock = 0;
    this._landPromptT = 0;
    this._time = 0;
    this._skidN = 0;
    this._warned = new Set();
    /** debug: player's vehicle takes no damage */
    this.godVehicle = false;
  }

  /** The vehicle the player is driving (or null). */
  get playerVehicle() { return this._player; }

  // ============================================================================================ lifecycle

  init() {
    const g = this.game;
    const M = materials();
    // skid marks: one instanced mesh for every mark in the world (1 draw call)
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this._skid = new THREE.InstancedMesh(plane, M.skid, SKID_MAX);
    this._skid.frustumCulled = false;
    this._skid.count = 0;
    this._skid.visible = false;
    this._skid.renderOrder = 1;
    g.scene.add(this._skid);
    // one headlight spot for the player's vehicle at night (kept in the scene: no shader recompiles)
    this._spot = new THREE.SpotLight(0xfff0d0, 0, 60, 0.5, 0.55, 1.15);
    this._spot.castShadow = false;
    this._spotTarget = new THREE.Object3D();
    this._spot.target = this._spotTarget;
    g.scene.add(this._spot, this._spotTarget);
    // (siren glow at night pulses the pooled fx lights: see _updateSirenLight)
    this._sirenPulseT = 0;
    this._sirenSide = false;

    const ev = g.events;
    ev.on('explosion', (e) => {
      this._sawBlast = true;
      if (e && e.position) this._blasts.push({ x: e.position.x, y: e.position.y, z: e.position.z, r: e.radius || 4, p: e.power || 2, t: g.time });
    });
    ev.on('settingsChanged', (s) => {
      const sh = !!(s && s.shadows);
      for (const v of this.list) { v.bodyMesh.castShadow = sh; if (v.wheelMesh) v.wheelMesh.castShadow = sh; }
    });
    this._installDebug();
    try { this._streamParked(true); } catch (e) { console.warn('[vehicles] initial parking failed', e); }
  }

  /**
   * Spawn a vehicle. y may be undefined/NaN -> placed on the ground. opts: {color, parked, locked, persistent, owned,
   * health, flying (heli starts airborne with rotors at speed), blip}. Returns the Vehicle.
   */
  spawn(type, x, y, z, yaw = 0, opts = {}) {
    const g = this.game;
    if (!VEHICLE_TYPES[type]) {
      if (!this._warned.has(type)) { this._warned.add(type); console.warn('[vehicles] unknown type', type); }
      type = 'sedan';
    }
    opts = opts || {};
    x = Number(x); z = Number(z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    let ground = this._groundAt(x, z, Number.isFinite(y) ? y + 2 : undefined);
    if (!Number.isFinite(y)) y = ground;
    const v = new Vehicle(this, type, x, y, z, Number.isFinite(yaw) ? yaw : 0, opts);
    if (v.isHeli && (opts.flying || y > ground + 2.5)) { v.rotor = 1; v.onGround = false; }
    v.visY = y;
    g.scene.add(v.mesh);
    g.entities?.add?.(v);
    this.list.push(v);
    v.syncVisual(0, g.time || 0, null);
    return v;
  }

  /** Spawn a vehicle near pos: on the closest road/free ground within ~25 m, facing along the road. */
  spawnNear(type, pos, opts = {}) {
    const g = this.game, plan = g.generator && g.generator.plan;
    const def = VEHICLE_TYPES[type] || VEHICLE_TYPES.sedan;
    const px = pos ? pos.x : (g.player ? g.player.position.x : 256), pz = pos ? pos.z : (g.player ? g.player.position.z : 256);
    let best = null, bd = Infinity;
    for (let r = 3; r <= 25 && !best; r += 2) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2 + r * 0.37;
        const x = px + Math.cos(ang) * r, z = pz + Math.sin(ang) * r;
        const onRoad = plan && typeof plan.isRoad === 'function' ? plan.isRoad(x, z) : true;
        if (!onRoad && r < 20) continue;
        const y = this._groundAt(x, z);
        if (!this._spotFree(x, y, z, def)) continue;
        const d = Math.hypot(x - px, z - pz);
        if (d < bd) { bd = d; best = { x, y, z }; }
      }
    }
    if (!best) best = { x: px + 4, y: undefined, z: pz };
    let yaw = opts.yaw;
    if (!Number.isFinite(yaw)) {
      const road = plan && typeof plan.roadAt === 'function' ? plan.roadAt(best.x, best.z) : null;
      if (road && plan.nodes) {
        const a = plan.nodes[road.a], b = plan.nodes[road.b];
        yaw = a && b ? Math.atan2(b.x - a.x, b.z - a.z) : 0;
      } else yaw = Math.atan2(px - best.x, pz - best.z);
    }
    return this.spawn(type, best.x, best.y, best.z, yaw, opts);
  }

  /** Remove a vehicle (ejects the player first). Safe to call twice. */
  remove(v) {
    const i = this.list.indexOf(v);
    if (i < 0) return;
    if (v === this._player) this.exit({ force: true });
    if (v.fireHandle) { try { v.fireHandle.stop(); } catch (e) { /* ignore */ } v.fireHandle = null; }
    this._stopHandle(this._engines, v);
    this._stopHandle(this._sirens, v);
    this._stopHandle(this._alarms, v);
    this._stopHandle(this._fireLoops, v);
    const rider = this._riders.get(v);
    if (rider) { rider.dispose(); this._riders.delete(v); }
    this.game.entities?.remove?.(v);
    v.disposeMesh();
    this.list.splice(i, 1);
    v.removed = true;
    v.alive = false;
    if (v.spotIndex !== undefined && this._spots.get(v.spotIndex) === v) this._spots.delete(v.spotIndex);
    if (this._lastPlayerVehicle === v) this._lastPlayerVehicle = null;
    if (this._padHeli === v) this._padHeli = null;
  }

  /** Nearest vehicle (horizontal distance between centres) within maxDist matching filter(v). */
  findNearest(pos, maxDist = Infinity, filter = null) {
    if (!pos) return null;
    let best = null, bd = maxDist * maxDist;
    for (const v of this.list) {
      if (filter && !filter(v)) continue;
      const dx = v.position.x - pos.x, dz = v.position.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ============================================================================================ enter / exit

  /** Put the player in a vehicle (carjacks AI drivers, may trigger theft crimes). Returns true on success. */
  enter(v, opts = {}) {
    const g = this.game, p = g.player;
    if (!v || v.removed || v.destroyed || !p || p.alive === false) return false;
    if (this._player === v) return true;
    if (this._player) this.exit({ force: true });
    if (v.locked && !opts.force) {
      g.audio?.play?.('car_door', { position: v.position, volume: 0.35, pitch: 1.4 });
      g.hud?.notify?.('This vehicle is locked.', { duration: 2 });
      return false;
    }
    const pos = v.position.clone();
    let stolen = false;
    if (v.driver === 'ai' || (v.ai && v.driver)) {
      try { v.ai?.onCarjacked?.(v); } catch (e) { console.warn('[vehicles] onCarjacked', e); }
      stolen = true;
      g.events.emit('crime', { type: 'carjack', position: pos, severity: 1 });
      if (v.isPolice) g.events.emit('crime', { type: 'vehicleTheft', police: true, position: pos, severity: 2 });
    } else if (!v.owned && !v.everPlayer) {
      if (v.isPolice) {
        stolen = true;
        g.events.emit('crime', { type: 'vehicleTheft', police: true, position: pos, severity: 2 });
      } else if (!opts.quiet && Math.random() < 0.5) {
        stolen = true;
        g.events.emit('crime', { type: 'vehicleTheft', position: pos, severity: 1 });
        this._startAlarm(v, 8);
      }
    }
    if (v.ai) { try { v.ai.release?.(v); } catch (e) { console.warn('[vehicles] ai.release', e); } v.ai = null; }
    v.driver = 'player';
    v.parked = false;
    v.everPlayer = true;
    v.speedScale = 1;
    v.wake();
    v.controls.throttle = 0; v.controls.brake = 0; v.controls.handbrake = false; v.controls.lift = 0;
    if (v.isHeli && v.onGround) v.rotor = Math.max(v.rotor, 0.15);
    this._player = v;
    this._lastPlayerVehicle = v;
    v.setDriverLook(p.humanoid && p.humanoid.look ? p.humanoid.look : LOOKS.player);
    if (typeof p.setInVehicle === 'function') p.setInVehicle(v);
    else { p.inVehicle = v; p.hidden = true; }
    g.audio?.play?.('car_door', { position: v.position, volume: 0.8 });
    this._startPlayerEngine(v);
    g.events.emit('vehicleEnter', { vehicle: v, character: p, stolen });
    g.hud?.showVehicleName?.(v.def.name);
    return true;
  }

  /** Take the player out of their vehicle beside the driver door. opts: {force, exitPos}. */
  exit(opts = {}) {
    const g = this.game, p = g.player, v = this._player;
    if (!v) return false;
    const exitPos = opts.exitPos || this._findExitPos(v);
    const speed = Math.abs(v.speed);
    this._afterPlayerLeft(v);
    if (p && p.inVehicle === v) {
      if (typeof p.setInVehicle === 'function') p.setInVehicle(null, exitPos);
      else { p.inVehicle = null; p.hidden = false; p.position.copy(exitPos); }
    }
    // bailing out of a fast car: tumble out + some damage
    if (p && !v.isHeli && !opts.force && speed > 10 && p.alive !== false) {
      const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
      _imp.set(c * 3 + s * speed * 0.5, 3.5, -s * 3 + c * speed * 0.5);
      p.knockback?.(_imp);
      p.damage?.(Math.min(35, (speed - 10) * 2), { type: 'fall', source: null });
    }
    g.audio?.play?.('car_door', { position: exitPos, volume: 0.75, pitch: 0.95 });
    g.events.emit('vehicleExit', { vehicle: v, character: p });
    this._enterLock = 0.35;
    return true;
  }

  _afterPlayerLeft(v) {
    const g = this.game;
    if (v.driver === 'player') v.driver = null;
    const c = v.controls;
    c.throttle = 0; c.steer = 0; c.brake = 0; c.handbrake = false; c.lift = 0;
    this._player = null;
    if (this._pEngine) { try { this._pEngine.stop(); } catch (e) { /* ignore */ } this._pEngine = null; }
    if (this._horn) { try { this._horn.stop(); } catch (e) { /* ignore */ } this._horn = null; }
    if (this._screech) { try { this._screech.stop(); } catch (e) { /* ignore */ } this._screech = null; }
    g.hud?.setSpeed?.(null);
    const rider = this._riders.get(v);
    if (rider) { rider.dispose(); this._riders.delete(v); }
    v.setDriverLook(null);
  }

  /**
   * F pressed while driving. A flying heli refuses above ~4 m ('Land first'), unless it is burning or wrecked: then
   * the player bails out onto the ground below (emergency escape). Low hovers keep the ground snap.
   */
  _playerExitRequest(v) {
    const g = this.game;
    if (v.isHeli && !v.onGround) {
      const emergency = v.onFire || v.destroyed || v.health < v.maxHealth * 0.15;
      const w = g.world;
      const gy = w && typeof w.findGround === 'function' ? w.findGround(v.position.x, v.position.z, Math.floor(v.position.y + 0.5)) : -1;
      const above = gy > 0 ? v.position.y - gy : Infinity;
      if (above > 4 && !emergency) {
        this._landPromptT = 2;
        g.hud?.prompt?.('Land first (hold Shift to descend)');
        g.audio?.play?.('error', { volume: 0.5 });
        return false;
      }
      if (emergency) return this.exit({ exitPos: this._findExitPos(v, true) });
    }
    return this.exit();
  }

  /**
   * Free standing spot beside the vehicle: driver door, passenger door, behind, in front, roof.
   * snapToGround: a flying heli puts the player on the ground below at any height (emergency bail-out).
   */
  _findExitPos(v, snapToGround = false) {
    const g = this.game, w = g.world, d = v.def;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    const dz = v.meta.driver ? clamp(v.meta.driver.z, -d.size.l / 2 + 0.5, d.size.l / 2 - 0.5) : 0;
    const side = d.size.w / 2 + 0.55;
    const cands = [[side, dz], [-side, dz], [side, dz - 1.2], [-side, dz + 1.2], [0, -d.size.l / 2 - 0.7], [0, d.size.l / 2 + 0.7], [side + 1, dz]];
    if (v.flooded || v.inWater) return new THREE.Vector3(v.position.x, v.position.y + d.size.h + 0.2, v.position.z);
    for (const [lx, lz] of cands) {
      const x = v.position.x + lx * cy + lz * sy, z = v.position.z - lx * sy + lz * cy;
      let y;
      if (v.isHeli && !v.onGround) {
        const gy = w ? w.findGround(x, z, Math.floor(v.position.y + 1)) : -1;
        y = gy > 0 && (snapToGround || v.position.y - gy < 10.5) ? gy : v.position.y;
      } else {
        const gy = sampleGround(w, x, z, v.position.y + 0.5, 4);
        if (!Number.isFinite(gy)) continue;
        y = gy;
      }
      if (w && boxCollides(w, x, y, z, 0.3, 1.8)) continue;
      let blocked = false;
      for (const o of this.list) {
        if (o === v || Math.abs(o.position.y - y) > 2) continue;
        if (pointInVehicle(o, x, z, 0.35, _pt) > 0) { blocked = true; break; }
      }
      if (!blocked) return new THREE.Vector3(x, y, z);
    }
    return new THREE.Vector3(v.position.x, v.position.y + d.size.h + 0.05, v.position.z);
  }

  /** Vehicle the player can enter right now (closest body within reach), or null. */
  _enterCandidate(p) {
    let best = null, bd = ENTER_REACH;
    const px = p.position.x, pz = p.position.z;
    for (const v of this.list) {
      if (v.destroyed || v === this._player) continue;
      if (p.position.y < v.position.y - 1.6 || p.position.y > v.position.y + v.def.size.h + 0.6) continue;
      if (v.isHeli && !v.onGround && v.driver) continue;
      const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
      const dx = px - v.position.x, dz = pz - v.position.z;
      const lf = dx * s + dz * c, lr = -dx * c + dz * s;
      const ox = Math.max(0, Math.abs(lr) - v.def.size.w / 2), oz = Math.max(0, Math.abs(lf) - v.def.size.l / 2);
      let d = Math.hypot(ox, oz);
      if (d >= bd && Math.hypot(dx, dz) <= 3.5) d = bd - 1e-3; // contract: anything within 3.5 m of the centre
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ============================================================================================ update

  update(dt) {
    const g = this.game, world = g.world;
    if (!world || typeof world.isSolid !== 'function') return;
    this._time += dt;
    this._handlePlayer(dt);
    const focus = this._focus(_v2);
    this._processBlasts();
    for (const v of this.list) this._simulate(v, dt, focus);
    this._pairs();
    this._hitEntities();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v) this._post(v, dt, focus);
    }
    const pv = this._player, p = g.player;
    if (pv && p && p.inVehicle === pv) {
      p.position.copy(pv.position);
      if (p.velocity) p.velocity.copy(pv.velocity);
    }
    this._audio(dt, focus);
    this._updateSpot();
    this._updateSirenLight(focus, dt);
    this._streamT -= dt;
    if (this._streamT <= 0) {
      this._streamT = 0.8;
      this._cleanup(focus);
      this._streamParked(false);
    }
  }

  _focus(out) {
    const g = this.game;
    if (g.player && g.player.position) return out.copy(g.player.position);
    return out.copy(g.camera.position);
  }

  // ---------------------------------------------------------------- player input
  _handlePlayer(dt) {
    const g = this.game, p = g.player, inp = g.input;
    if (!p || !inp) return;
    let v = this._player;
    if (v && (p.inVehicle !== v || v.removed)) {
      // the player module moved us out (death / respawn / teleport) or the vehicle vanished
      this._afterPlayerLeft(v);
      g.events.emit('vehicleExit', { vehicle: v, character: p });
      if (p.inVehicle === v) { if (typeof p.setInVehicle === 'function') p.setInVehicle(null); else p.inVehicle = null; }
      v = null;
    }
    if (v) {
      const c = v.controls;
      if (p.alive === false || p.frozen) { c.throttle = 0; c.steer = 0; c.brake = 1; c.handbrake = false; c.lift = 0; return; }
      const ax = inp.moveAxis();
      c.throttle = ax.y;
      c.steer = ax.x;
      c.brake = 0;
      if (v.isHeli) {
        c.lift = (inp.down('jump') ? 1 : 0) - (inp.down('sprint') ? 1 : 0);
        c.handbrake = false;
      } else {
        c.handbrake = inp.down('jump');
        c.lift = 0;
      }
      if (inp.pressed('horn')) {
        if (v.def.siren) this.toggleSiren(v);
        else if (!this._horn && g.audio) this._horn = g.audio.loop?.('horn', { position: v.position, volume: 1, pitch: v.def.mass > 3000 ? 0.72 : v.isBike ? 1.3 : 1 }) || null;
      }
      if (this._horn) {
        if (!inp.down('horn')) { try { this._horn.stop(); } catch (e) { /* ignore */ } this._horn = null; }
        else this._horn.setPosition?.(v.position);
      }
      if (inp.pressed('lights')) {
        v.lightsOverride = !v.lightsOn;
        g.audio?.play?.('ui_click', { volume: 0.3 });
      }
      g.hud?.setSpeed?.(Math.round(Math.abs(v.isHeli ? Math.hypot(v.velocity.x, v.velocity.z) : v.speed) * 3.6));
      if (this._landPromptT > 0) {
        this._landPromptT -= dt;
        if (v.isHeli && !v.onGround) g.hud?.prompt?.('Land first (hold Shift to descend)');
        else this._landPromptT = 0;
      }
      if (inp.pressed('enterVehicle')) this._playerExitRequest(v);
      return;
    }
    this._enterLock -= dt;
    if (p.alive === false || p.frozen || p.handsUp || p.inVehicle) return;
    const cand = this._enterCandidate(p);
    if (cand) {
      g.hud?.prompt?.(cand.locked ? `${cand.def.name} is locked` : `Press F to enter ${cand.def.name}`);
      if (inp.pressed('enterVehicle') && this._enterLock <= 0) this.enter(cand);
    }
  }

  /** Toggle a police vehicle's siren + light bar (player). */
  toggleSiren(v) {
    const g = this.game;
    v.sirenOn = !v.sirenOn;
    if (v.sirenOn) {
      g.audio?.play?.('siren_chirp', { position: v.position });
      const h = g.audio?.siren?.();
      if (h) { this._stopHandle(this._sirens, v); this._sirens.set(v, h); h.setPosition?.(v.position); }
    } else this._stopHandle(this._sirens, v);
    return v.sirenOn;
  }

  // ---------------------------------------------------------------- simulation
  _simulate(v, dt, focus) {
    v.impact = 0; v.scrape = 0; v.touching = false; v.landImpact = 0; v.rotorStrike = 0;
    const dx = v.position.x - focus.x, dz = v.position.z - focus.z;
    v.distSq = dx * dx + dz * dz;
    if (v !== this._player && v.distSq > SIM_RADIUS * SIM_RADIUS) { v.frozen = true; return; }
    v.frozen = false;
    const world = this.game.world;
    if (v.isHeli && v.autopilot && v.driver !== 'player' && !v.destroyed) heliAutopilot(v);
    if (v.sleeping) {
      if (v.driver && !v.destroyed) v.wake();
      else {
        v.sleepCheck = (v.sleepCheck || 0) - dt;
        if (v.sleepCheck > 0) return;
        v.sleepCheck = 0.5;
        const gy = sampleGround(world, v.position.x, v.position.z, v.position.y, 3);
        if (gy === v.position.y || Math.abs(gy - v.position.y) < 0.03) return;
        v.wake();
      }
    }
    v._preVel.copy(v.velocity);
    v._preYawRate = v.yawRate;
    const sp = Math.hypot(v.velocity.x, v.velocity.z) + Math.abs(v.velocity.y) + Math.abs(v.yawRate) * v.def.size.l * 0.5;
    const n = clamp(Math.ceil((sp * dt) / 0.42), 1, 10);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (v.isHeli) stepHeli(v, h, world); else stepCar(v, h, world);
    }
    v.speed = v.isHeli ? v.speed : v.forwardSpeed;
    // sleep idle driverless vehicles
    const idle = !v.driver && v.onGround && !v.onFire && !v.inWater && Math.abs(v.velocity.x) + Math.abs(v.velocity.z) < 0.08 &&
      Math.abs(v.yawRate) < 0.02 && (!v.isHeli || v.rotor < 0.02);
    if (idle) {
      v.sleepT += dt;
      if (v.sleepT > 1.0) { v.sleeping = true; v.velocity.set(0, 0, 0); v.yawRate = 0; v.speed = 0; v.sleepCheck = 0.5; }
    } else v.sleepT = 0;
  }

  _pairs() {
    const L = this.list, n = L.length, c = this._contact;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      if (a.frozen) continue;
      const ax = a.position.x, az = a.position.z, ar = a.boundR, as = a.sleeping;
      for (let j = i + 1; j < n; j++) {
        const b = L[j];
        if (b.frozen || (as && b.sleeping)) continue;
        // cheap bounding-circle reject before the OBB test
        const rr = ar + b.boundR, dx = ax - b.position.x, dz = az - b.position.z;
        if (dx > rr || dx < -rr || dz > rr || dz < -rr) continue;
        const imp = collidePair(a, b, c);
        if (imp > 0) {
          if (imp > 0.6) { a.wake(); b.wake(); }
          if (imp > 2) this._vehicleImpact(a, b, imp, c);
        }
      }
    }
  }

  _vehicleImpact(a, b, imp, c) {
    const g = this.game;
    const ma = a.def.mass, mb = b.def.mass;
    if (imp > 7) {
      const base = (imp - 7) * 6;
      const srcA = b.driver === 'player' ? g.player : b, srcB = a.driver === 'player' ? g.player : a;
      _v.set(c.x, c.y, c.z);
      this._crashDamage(a, base * clamp((2 * mb) / (ma + mb), 0.3, 1.7), { type: 'vehicle', source: srcA, point: _v.clone() });
      this._crashDamage(b, base * clamp((2 * ma) / (ma + mb), 0.3, 1.7), { type: 'vehicle', source: srcB, point: _v.clone() });
    }
    try { a.ai?.onCollision?.(a, b, imp); } catch (e) { /* optional hook */ }
    try { b.ai?.onCollision?.(b, a, imp); } catch (e) { /* optional hook */ }
    const t = this._time;
    if (imp > 3 && t > (a.crashFxT || 0) && t > (b.crashFxT || 0)) {
      a.crashFxT = b.crashFxT = t + 0.22;
      _v.set(c.x, c.y, c.z);
      g.audio?.play?.('crash', { position: _v, volume: clamp((imp - 2) / 16, 0.2, 1), pitch: 0.85 + Math.random() * 0.3 });
      _v2.set(c.nx, 0.4, c.nz).normalize();
      try { g.fx?.sparks?.(_v, _v2); } catch (e) { /* fx stub */ }
      if (imp > 16) g.audio?.play?.('glass_break', { position: _v, volume: 0.6 });
      if (imp > 9) { try { g.fx?.burst?.(_v, { color: a.color, count: 6, speed: 4, size: 0.12, life: 1.2, gravity: 20 }); } catch (e) { /* ignore */ } }
    }
    if (a === this._player || b === this._player) g.cameraRig?.shake?.(clamp(imp / 26, 0.08, 0.6));
    for (const v of [a, b]) if (v === this._player && v.isBike && imp > 13) this._ejectRider(v, imp);
  }

  _hitEntities() {
    const g = this.game, ents = g.entities;
    if (!ents || !ents.query) return;
    const out = this._entOut, t = g.time;
    for (const v of this.list) {
      if (v.frozen || v.sleeping) continue;
      const sp = Math.hypot(v.velocity.x, v.velocity.z);
      if (sp < 0.5 && Math.abs(v.yawRate) < 0.25) continue;
      _v.set(v.position.x, v.position.y + v.def.size.h * 0.5, v.position.z);
      ents.query(_v, v.boundR + 1.2, null, out);
      for (const e of out) {
        if (e === v || e.kind === 'vehicle' || e.kind === 'heli' || e.kind === 'tnt' || e.alive === false) continue;
        if (e === g.player && g.player.inVehicle) continue;
        const eh = e.height || 1.8;
        if (e.position.y > v.position.y + v.def.size.h - 0.15 || e.position.y + eh < v.position.y + 0.12) continue;
        const pen = pointInVehicle(v, e.position.x, e.position.z, e.radius || 0.3, _pt);
        if (!(pen > 0)) continue;
        const nx = _pt.nx, nz = _pt.nz;
        const rx = e.position.x - v.position.x, rz = e.position.z - v.position.z;
        const vpx = v.velocity.x + v.yawRate * rz, vpz = v.velocity.z - v.yawRate * rx;
        const ev = e.velocity;
        const rel = (vpx - (ev ? ev.x : 0)) * nx + (vpz - (ev ? ev.z : 0)) * nz;
        // backstop: an AI driver nudging the player at low speed stops dead instead of running them over
        if (e === g.player && v.ai && v.driver !== 'player' && sp < 9) {
          const vn = v.velocity.x * nx + v.velocity.z * nz;
          if (vn > 0) { v.velocity.x -= vn * nx; v.velocity.z -= vn * nz; }
          v.yawRate *= 0.5;
          v.controls.throttle = 0; v.controls.brake = 1;
          try { v.ai.onBumpedPerson?.(e); } catch (err) { /* optional hook */ }
          continue;
        }
        if (rel > 3 && (this._hitCD.get(e) || 0) <= t) {
          this._hitCD.set(e, t + 0.7);
          const source = v.driver === 'player' ? g.player : v;
          _v.set(e.position.x, e.position.y + 1, e.position.z);
          try { e.damage?.(rel * 4, { type: 'vehicle', source, point: _v.clone(), dir: new THREE.Vector3(nx, 0.3, nz) }); } catch (err) { console.warn('[vehicles] hit damage', err); }
          _imp.set(nx * (rel * 0.85 + 1.5) + v.velocity.x * 0.15, Math.min(11, 3 + rel * 0.35), nz * (rel * 0.85 + 1.5) + v.velocity.z * 0.15);
          if (typeof e.knockback === 'function') { try { e.knockback(_imp); } catch (err) { /* ignore */ } }
          else if (e.velocity) e.velocity.add(_imp);
          const slow = 1 - clamp(90 / v.def.mass, 0.005, 0.25);
          v.velocity.x *= slow; v.velocity.z *= slow;
          g.audio?.play?.('punch', { position: _v, volume: clamp(rel / 14, 0.4, 1), pitch: 0.7 });
          if (rel > 8) g.audio?.play?.('crash', { position: _v, volume: 0.35, pitch: 1.3 });
          if (v === this._player) g.cameraRig?.shake?.(clamp(rel / 50, 0.05, 0.3));
          if (source === g.player && rel > 7 && (e.kind === 'ped' || e.kind === 'cop')) {
            g.events.emit('crime', { type: 'hitAndRun', position: e.position.clone(), severity: 1, victim: e });
          }
        } else if (e !== g.player) {
          const push = Math.min(pen, 0.25) + 0.01;
          e.position.x += nx * push; e.position.z += nz * push;
        }
      }
    }
    if (this._hitCD.size > 64) for (const [e, tt] of this._hitCD) if (tt < t) this._hitCD.delete(e);
  }

  _processBlasts() {
    if (!this._blasts.length) return;
    for (const b of this._blasts) {
      const R = b.r * 1.7;
      for (const v of this.list) {
        if (v.frozen) continue;
        if (v.knockT !== undefined && v.knockT >= b.t) continue; // combat already pushed it
        const cx = v.position.x, cy = v.position.y + v.def.size.h * 0.5, cz = v.position.z;
        const dx = cx - b.x, dy = cy - b.y, dz = cz - b.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > R) continue;
        const f = 1 - d / R;
        const hl = Math.hypot(dx, dz) || 1;
        const mag = (6 + b.p * 4) * f;
        _imp.set((dx / hl) * mag, mag * 0.9 + 2 * f, (dz / hl) * mag);
        v.knockback(_imp);
      }
    }
    this._blasts.length = 0;
  }

  // ---------------------------------------------------------------- per-vehicle post-processing
  _post(v, dt, focus) {
    const g = this.game;
    if (v.removed) return;
    if (v.position.y < -24) {
      if (v === this._player) this.exit({ force: true, exitPos: this._safeGround(v.position.x, v.position.z) });
      this.remove(v);
      return;
    }
    const night = g.sky ? g.sky.nightFactor || 0 : 0;
    v.alarmT -= dt;
    v.hornT -= dt;
    if (!v.frozen) {
      if (v.impact > 1.2) this._wallImpact(v);
      if (v.landImpact > 2.5) this._landing(v);
      if (v.rotorStrike > 0) this._rotorStrikeFx(v, dt);
      if (v.touching && v.scrape > 4.5 && this._time > (v.scrapeFxT || 0)) {
        v.scrapeFxT = this._time + 0.07;
        _v.set(v.contactX, v.position.y + 0.6, v.contactZ);
        _v2.set(v.contactNX, 0.3, v.contactNZ);
        try { g.fx?.sparks?.(_v, _v2); } catch (e) { /* ignore */ }
        if (v === this._player && this._time > (v.scrapeSndT || 0)) {
          v.scrapeSndT = this._time + 0.35;
          g.audio?.play?.('crash', { position: _v, volume: clamp(v.scrape / 30, 0.12, 0.35), pitch: 1.5 });
        }
      }
      // water
      if (v.inWater && !v.wasInWater && Math.abs(v.velocity.y) + Math.hypot(v.velocity.x, v.velocity.z) > 2) {
        _v.set(v.position.x, v.position.y + 0.5, v.position.z);
        try { g.fx?.splash?.(_v); } catch (e) { /* ignore */ }
        g.audio?.play?.('splash', { position: _v, volume: 1 });
      }
      v.wasInWater = v.inWater;
      if (v.flooded && !v.destroyed) {
        v.floodT += dt;
        if (Math.random() < dt * 6) { _v.set(v.position.x + (Math.random() - 0.5) * v.def.size.w, v.position.y + v.def.size.h, v.position.z); try { g.fx?.burst?.(_v, { color: 0xcfe8ff, count: 2, speed: 0.6, size: 0.08, life: 0.8, gravity: -4 }); } catch (e) { /* ignore */ } }
        if (v.floodT > 3) this._drown(v);
      }
    }
    // health effects
    if (!v.destroyed) {
      const hp = v.health / v.maxHealth;
      if (hp < 0.4 && v.distSq < 110 * 110 && !v.inWater) {
        const heavy = hp < 0.22;
        try { g.fx?.smoke?.(v.enginePos, { amount: (heavy ? 13 : 6) * dt, color: heavy ? 0x1c1c1c : 0x6a6a6a }); } catch (e) { /* ignore */ }
      }
      if (hp < 0.15 && !v.onFire && !v.inWater) this.igniteVehicle(v);
      if (v.onFire) {
        v.fireT += dt;
        if (v.inWater) { v.onFire = false; v.fireT = 0; if (v.fireHandle) { v.fireHandle.stop?.(); v.fireHandle = null; } }
        else if (v.fireT >= (v.fireFuse || 4)) this.explodeVehicle(v, v.lastAttacker);
      }
    } else {
      v.destroyedT += dt;
      if (v.destroyedT < 25 && v.distSq < 90 * 90 && !v.inWater) {
        try { g.fx?.smoke?.(v.enginePos, { amount: 3 * dt, color: 0x202020 }); } catch (e) { /* ignore */ }
      }
    }
    // lights
    const lightsWas = v.lightsOn;
    v.lightsOn = !v.destroyed && (v.lightsOverride !== null && v.lightsOverride !== undefined ? !!v.lightsOverride : (night > 0.5 && !!v.driver));
    if (v.lightsOn !== lightsWas) v._visSynced = false;
    // simulated engine rpm (gearbox)
    if (!v.isHeli) {
      const thr = Math.abs(v.controls.throttle || 0);
      let target = v.driver ? gearboxRpm(v.speed, v.def.maxSpeed, thr) : 0;
      if (v.driver && (!v.onGround || v.burnout)) target = 0.3 + 0.65 * thr;
      v.rpm += (target - v.rpm) * damp(9, dt);
    }
    // skid marks + tyre smoke, launch exhaust puffs, off-road dust
    if (v.distSq < 75 * 75) this._skids(v, dt); else v.skidPrev = null;
    if (!v.isHeli && !v.destroyed && v.driver && v.onGround && v.distSq < 45 * 45 && !v.inWater) this._trails(v, dt);
    // visuals: hidden beyond the fog (no draw calls); parked cars asleep keep their last pose (no per-frame sync)
    const show = v === this._player || this._withinFog(v);
    v.mesh.visible = show;
    if (show && (!v.frozen || v.distSq < (SIM_RADIUS + 20) ** 2)) {
      const root = v.mesh.position;
      if (!(v._visSynced && v.sleeping && !v.driver && root.x === v.position.x && root.z === v.position.z && v.mesh.rotation.y === v.yaw)) {
        v.syncVisual(dt, g.time, { hideDriver: v === this._player && this._hoodCam() });
        // settled while asleep (no springs moving, no flashing lights): stop syncing until something changes
        v._visSynced = v.sleeping && !v.driver && !v.sirenOn && !(v.alarmT > 0) && !v.onFire && v.tumble === 0 &&
          Math.abs(v.susp) < 1e-3 && Math.abs(v.suspV) < 1e-3 && Math.abs(v.position.y - v.visY) < 1e-3;
      }
    } else v._visSynced = false;
    if (v.isBike) this._updateRider(v, dt);
  }

  /** Is the vehicle closer to the camera than the fog end (plus its size)? */
  _withinFog(v) {
    const g = this.game, far = g.scene && g.scene.fog ? g.scene.fog.far : 0;
    if (!(far > 0) || !g.camera) return true;
    const cp = g.camera.position;
    const dx = v.position.x - cp.x, dz = v.position.z - cp.z;
    const r = far + 6 + v.boundR;
    return dx * dx + dz * dz < r * r;
  }

  /** A safe standing spot on the surface at (x, z) (top of the column, or the plan's surface height). */
  _safeGround(x, z) {
    const g = this.game, w = g.world, plan = g.generator && g.generator.plan;
    let y = -1;
    try { if (w && typeof w.findGround === 'function') y = w.findGround(x, z, 95); } catch (e) { y = -1; }
    if (!(y > 0) && plan && typeof plan.surfaceY === 'function') y = plan.surfaceY(x, z);
    return new THREE.Vector3(x, y > 0 ? y : WORLD.CITY_LEVEL, z);
  }

  _hoodCam() {
    const r = this.game.cameraRig;
    return !!(r && r.vehicleMode === 'hood');
  }

  _wallImpact(v) {
    const g = this.game, imp = v.impact;
    if (!v.isHeli && imp > 6 && this._breakProps(v, imp)) return;
    _v.set(v.contactX, v.position.y + Math.min(1, v.def.size.h * 0.5), v.contactZ);
    if (imp > 9) {
      // softened + capped: heavy vehicles shrug off hits, one crash never takes more than 35% of the health bar
      const kClass = v.isBike ? 0.8 : v.isHeli ? 1.4 : 1;
      this._crashDamage(v, (imp - 9) * 5 * kClass * clamp(1500 / v.def.mass, 0.6, 1.2), { type: 'vehicle', source: null, point: _v.clone() });
    }
    if (imp > 2.5 && this._time > (v.crashFxT || 0)) {
      v.crashFxT = this._time + 0.22;
      g.audio?.play?.('crash', { position: _v, volume: clamp((imp - 2) / 18, 0.15, 1), pitch: 0.8 + Math.random() * 0.35 });
      _v2.set(v.contactNX, 0.35, v.contactNZ).normalize();
      try { g.fx?.sparks?.(_v, _v2); } catch (e) { /* ignore */ }
      if (imp > 10) {
        const w = g.world;
        const bid = w ? w.getBlock(Math.floor(v.contactX - v.contactNX * 0.2), Math.floor(_v.y), Math.floor(v.contactZ - v.contactNZ * 0.2)) : 0;
        try { g.fx?.burst?.(_v, { color: bid ? undefined : 0x888888, count: 8, speed: 5, size: 0.14, life: 1.1, gravity: 22 }); } catch (e) { /* ignore */ }
      }
      if (imp > 18) g.audio?.play?.('glass_break', { position: _v, volume: 0.7 });
    }
    if (v === this._player) g.cameraRig?.shake?.(clamp(imp / 28, 0.05, 0.65));
    if (v === this._player && v.isBike && imp > 13) this._ejectRider(v, imp);
  }

  /**
   * Crash damage (walls / vehicles) with a per-hit cap: everything within 0.3 s counts as one hit and together never
   * exceeds 35% of maxHealth. Combat damage does not go through here.
   */
  _crashDamage(v, raw, info) {
    if (!(raw > 0) || v.destroyed) return;
    const t = this._time;
    if (!(t < (v._crashWinT || 0))) { v._crashWinT = t + 0.3; v._crashWinDmg = 0; }
    const amt = Math.min(raw, 0.35 * v.maxHealth - v._crashWinDmg);
    if (!(amt > 0)) return;
    v._crashWinDmg += amt;
    v.damage(amt, info);
  }

  /** Material class of a block as a breakable street prop (see PROP) at (x, y, z), 0 = not breakable. */
  _propAt(w, x, y, z) {
    const id = w.getBlock(x, y, z);
    const k = PROP[id];
    if (k !== 2) return k;
    // pole material: only free-standing columns (never building walls / corners)
    return w.isSolid(x + 1, y, z) || w.isSolid(x - 1, y, z) || w.isSolid(x, y, z + 1) || w.isSolid(x, y, z - 1) ? 0 : 2;
  }

  /**
   * The car hit a breakable street prop (lamp post, street-tree trunk, hedge, glass) hard enough: snap it and keep
   * most of the speed (GTA-style). Generated props are removed without recording an edit, so they return after a
   * reload; player-placed blocks (present in world.edits) are recorded so they stay broken.
   * Returns true when something broke (the normal wall impact is skipped).
   */
  _breakProps(v, imp) {
    const g = this.game, w = g.world;
    if (!w || typeof w.setBlock !== 'function') return false;
    const cx = Math.floor(v.contactX - v.contactNX * 0.2), cz = Math.floor(v.contactZ - v.contactNZ * 0.2);
    // body band the collision samples cover (above the step height): every solid cell there must be breakable
    const yA = Math.floor(v.position.y + 1.11), yB = Math.max(yA, Math.floor(v.position.y + v.def.size.h - 0.12));
    let kind = 0;
    for (let y = yA; y <= yB; y++) {
      const k = this._propAt(w, cx, y, cz);
      if (k === 0) { if (w.isSolid(cx, y, cz)) return false; continue; }
      if (k > kind) kind = k;
    }
    if (!kind) return false;
    const list = _brk;
    list.length = 0;
    const add = (x, y, z) => { const id = w.getBlock(x, y, z); if (id) list.push(x, y, z, id); };
    if (kind >= 2) {
      // the connected vertical run of pole material (max 6) plus the lamp head, from the car's floor upward
      const id0 = w.getBlock(cx, yA, cz) || w.getBlock(cx, yB, cz);
      const fam = (id) => id === id0 || (PROP[id] === 2 && PROP[id0] === 2 && BLOCKS[id].key.endsWith('LOG') === BLOCKS[id0].key.endsWith('LOG'));
      let y = yA;
      while (y > yA - 3 && fam(w.getBlock(cx, y - 1, cz)) && y - 1 >= 1) y--;
      let x = cx, z = cz, n = 0, top = y;
      for (; n < 6; n++, y++) {
        let id = w.getBlock(x, y, z);
        if (!fam(id)) {
          // bent palm trunks continue diagonally
          let moved = false;
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (fam(w.getBlock(x + ox, y, z + oz)) && !w.isSolid(x + ox, y - 1, z + oz)) { x += ox; z += oz; moved = true; break; }
          }
          if (!moved) break;
          id = w.getBlock(x, y, z);
        }
        list.push(x, y, z, id);
        top = y;
      }
      const head = w.getBlock(x, top + 1, z);
      if (PROP[head] === 3) list.push(x, top + 1, z, head);
      // a tree crown would float: clear the leaves around the top of the trunk
      if (BLOCKS[id0] && BLOCKS[id0].key.endsWith('LOG')) {
        const r = BLOCKS[id0].key === 'PALM_LOG' ? 4 : 2;
        for (let yy = top - (r > 2 ? 2 : 1); yy <= top + 3; yy++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              const id = w.getBlock(x + dx, yy, z + dz);
              if (PROP[id] === 1 && BLOCKS[id].key !== 'GLASS' && BLOCKS[id].key !== 'HEDGE') list.push(x + dx, yy, z + dz, id);
              else if (dx === 0 && dz === 0 && fam(id) && yy > top) list.push(x, yy, z, id);
            }
          }
        }
      }
    } else {
      // glass / hedge / leaves: punch a car-sized hole across the contact face
      const tx = Math.abs(v.contactNX) > Math.abs(v.contactNZ) ? 0 : 1, tz = 1 - tx;
      const half = Math.ceil(v.def.size.w / 2);
      for (let k = -half; k <= half; k++) {
        const x = cx + tx * k, z = cz + tz * k;
        for (let y = Math.floor(v.position.y); y <= yB + 1; y++) if (PROP[w.getBlock(x, y, z)] === 1) add(x, y, z);
      }
    }
    if (!list.length) return false;
    let glass = false, fxN = 0;
    for (let i = 0; i < list.length; i += 4) {
      const x = list[i], y = list[i + 1], z = list[i + 2], id = list[i + 3];
      // generated street props come back after a reload; anything the player built stays smashed
      const placed = !!(w.edits && w.edits.has(x + ',' + y + ',' + z));
      if (!w.setBlock(x, y, z, 0, { record: placed })) continue;
      if (BLOCKS[id] && BLOCKS[id].key === 'GLASS') glass = true;
      if (fxN++ < 12) { try { g.fx?.blockBreak?.(x, y, z, id); } catch (e) { /* ignore */ } }
    }
    // keep ~70% of the speed the car had before the frame (along its original direction), light damage only
    const pv = v._preVel;
    if (v.velocity.x ** 2 + v.velocity.z ** 2 < 0.49 * (pv.x * pv.x + pv.z * pv.z)) {
      v.velocity.x = pv.x * 0.7; v.velocity.z = pv.z * 0.7;
      v.yawRate = v._preYawRate * 0.7 + (v.yawRate - v._preYawRate) * 0.15;
    }
    _v.set(v.contactX, v.position.y + Math.min(1, v.def.size.h * 0.5), v.contactZ);
    this._crashDamage(v, Math.max(0, imp - 6) * 2, { type: 'vehicle', source: null, point: _v.clone() });
    if (this._time > (v.crashFxT || 0)) {
      v.crashFxT = this._time + 0.15;
      g.audio?.play?.(glass ? 'glass_break' : 'crash', { position: _v, volume: clamp(imp / 22, 0.35, 0.9), pitch: glass ? 1 : 1.25 });
    }
    if (v === this._player) g.cameraRig?.shake?.(clamp(imp / 70, 0.04, 0.2));
    return true;
  }

  _landing(v) {
    const g = this.game, imp = v.landImpact;
    v.suspV -= Math.min(4, imp * 0.11);
    if (imp > 7 && this._time > (v.landFxT || 0)) {
      v.landFxT = this._time + 0.25;
      _v.set(v.position.x, v.position.y + 0.2, v.position.z);
      g.audio?.play?.(imp > 11 ? 'crash' : 'land', { position: _v, volume: clamp(imp / 20, 0.25, 1), pitch: imp > 11 ? 0.75 : 0.6 });
      if (imp > 9) {
        try { g.fx?.dust?.(_v, { amount: 6 }); } catch (e) { /* ignore */ }
        if (imp > 13) { try { g.fx?.sparks?.(_v, _ey); } catch (e) { /* ignore */ } }
      }
      if (v === this._player) g.cameraRig?.shake?.(clamp(imp / 32, 0.06, 0.6));
    }
    const limit = v.isHeli ? 9 : 15;
    if (imp > limit) v.damage((imp - limit) * (v.isHeli ? 40 : 22), { type: 'fall', source: null });
  }

  _rotorStrikeFx(v, dt) {
    const g = this.game;
    v.damage(10 + v.rotorStrike * 4, { type: 'vehicle', source: null });
    v.rotor = Math.max(0.3, v.rotor - dt * 0.8);
    if (this._time > (v.crashFxT || 0)) {
      v.crashFxT = this._time + 0.15;
      v.localToWorld(0, 2.6, 0, _v);
      g.audio?.play?.('crash', { position: _v, volume: 0.8, pitch: 1.4 });
      try { g.fx?.sparks?.(_v, _ey); } catch (e) { /* ignore */ }
      if (v === this._player) g.cameraRig?.shake?.(0.35);
    }
  }

  /** Set a vehicle on fire; it explodes `fuse` seconds later unless repaired / flooded. */
  igniteVehicle(v, fuse = 4) {
    if (!v || v.destroyed || v.onFire) return;
    // the player's own ride burns longer: bailing out is a choice, not a race
    if (v === this._player || v.driver === 'player') fuse = Math.max(fuse, 7);
    v.onFire = true;
    v.fireT = 0;
    v.fireFuse = fuse;
    try { v.fireHandle = this.game.fx?.fire?.(v.enginePos) || null; } catch (e) { v.fireHandle = null; }
  }

  /** Blow a vehicle up now (combat explosion, burnt wreck, occupants killed). */
  explodeVehicle(v, source = null) {
    const g = this.game;
    if (!v || v.destroyed || v.removed) return;
    const src = source || v.lastAttacker || (v.driver === 'player' ? g.player : null);
    v.destroyed = true;
    v.alive = false;
    v.health = 0;
    v.onFire = false;
    v.sirenOn = false;
    v.destroyedT = 0;
    if (v.fireHandle) { try { v.fireHandle.stop(); } catch (e) { /* ignore */ } v.fireHandle = null; }
    this._stopHandle(this._engines, v);
    this._stopHandle(this._sirens, v);
    this._stopHandle(this._alarms, v);
    // occupants
    const wasPlayer = v === this._player;
    if (wasPlayer) this.exit({ force: true });
    if (v.ai) { try { v.ai.onDestroyed?.(v); } catch (e) { /* optional hook */ } }
    v.driver = null;
    // wreck: charred model + a hop and spin
    v.setBurnt();
    v.wake();
    v.velocity.y = Math.max(v.velocity.y, 0) + 6.5 + Math.random() * 2.5;
    v.velocity.x *= 0.5; v.velocity.z *= 0.5;
    v.onGround = false;
    v.yawRate += (Math.random() - 0.5) * 3;
    v.tumbleV += (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 2);
    if (v.isHeli) v.rotor = 0;
    const centre = new THREE.Vector3(v.position.x, v.position.y + v.def.size.h * 0.5, v.position.z);
    this._boom(centre, src, v);
    if (wasPlayer && g.player && g.player.alive !== false) g.player.damage?.(999, { type: 'explosion', source: src });
    try { v.fireHandle = g.fx?.fire?.(v.enginePos, 9 + Math.random() * 5) || null; } catch (e) { v.fireHandle = null; }
    g.events.emit('entityKilled', { entity: v, info: { type: 'explosion', source: src } });
    g.events.emit('vehicleDestroyed', { vehicle: v, source: src });
  }

  /** Explosion through Combat; falls back to local fx/damage if Combat did not handle it. */
  _boom(pos, src, self) {
    const g = this.game;
    this._sawBlast = false;
    const opts = { radius: 4.5, power: 2, damage: 120, source: src };
    try { if (g.combat && typeof g.combat.explode === 'function') g.combat.explode(pos, opts); } catch (e) { console.warn('[vehicles] combat.explode failed', e); }
    if (this._sawBlast) return;
    // fallback (Combat missing or a stub)
    try { g.fx?.explosion?.(pos, opts.radius); } catch (e) { /* ignore */ }
    g.audio?.play?.('explosion', { position: pos, volume: 1 });
    try { g.world?.explode?.(pos, 2.5, opts.power); } catch (e) { /* ignore */ }
    const ents = g.entities;
    if (ents && ents.query) {
      for (const e of ents.query(pos, opts.radius, null, [])) {
        if (e === self || e.hidden) continue;
        const d = Math.hypot(e.position.x - pos.x, e.position.y + (e.height || 1) * 0.5 - pos.y, e.position.z - pos.z);
        const f = clamp(1 - d / opts.radius, 0, 1);
        try { e.damage?.(opts.damage * f, { type: 'explosion', source: src, point: pos.clone() }); } catch (err) { /* ignore */ }
        const hx = e.position.x - pos.x, hz = e.position.z - pos.z, hl = Math.hypot(hx, hz) || 1;
        try { e.knockback?.(new THREE.Vector3((hx / hl) * 12 * f, 6 * f + 2, (hz / hl) * 12 * f)); } catch (err) { /* ignore */ }
      }
    }
    if (src && src === g.player) g.events.emit('crime', { type: 'explosion', position: pos.clone(), severity: 1 });
    g.events.emit('explosion', { position: pos.clone(), radius: opts.radius, power: opts.power, source: src });
  }

  _drown(v) {
    const g = this.game;
    if (v.destroyed) return;
    v.destroyed = true;
    v.alive = false;
    v.health = 0;
    v.onFire = false;
    v.sirenOn = false;
    if (v.fireHandle) { try { v.fireHandle.stop(); } catch (e) { /* ignore */ } v.fireHandle = null; }
    this._stopHandle(this._engines, v);
    this._stopHandle(this._sirens, v);
    this._stopHandle(this._alarms, v);
    if (v === this._player) {
      this.exit({ force: true, exitPos: new THREE.Vector3(v.position.x, v.position.y + v.def.size.h + 0.2, v.position.z) });
      g.hud?.notify?.('Your vehicle flooded and sank.', { duration: 3 });
    }
    if (v.ai) { try { v.ai.onDestroyed?.(v); } catch (e) { /* optional hook */ } }
    v.driver = null;
    v.setBurnt();
    v.destroyedT = 0;
    const src = v.lastAttacker || null;
    g.events.emit('entityKilled', { entity: v, info: { type: 'drown', source: src } });
    g.events.emit('vehicleDestroyed', { vehicle: v, source: src });
  }

  _ejectRider(v, imp) {
    const g = this.game, p = g.player;
    if (!p || this._player !== v) return;
    const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
    const exitPos = new THREE.Vector3(v.position.x - s * 0.6, v.position.y + 1.0, v.position.z - c * 0.6);
    const w = g.world;
    if (w && boxCollides(w, exitPos.x, exitPos.y, exitPos.z, 0.3, 1.8)) exitPos.set(v.position.x, v.position.y + 1.4, v.position.z);
    this.exit({ force: true, exitPos });
    _imp.set(s * Math.min(15, imp * 0.6), 5 + imp * 0.15, c * Math.min(15, imp * 0.6));
    p.knockback?.(_imp);
    p.damage?.(Math.min(60, imp * 2.2), { type: 'vehicle', source: null });
    g.hud?.notify?.('Thrown from the bike!', { duration: 2 });
  }

  // ---------------------------------------------------------------- skid marks
  _skids(v, dt) {
    const g = this.game;
    if (v.isHeli || v.destroyed || !v.onGround || v.inWater) { v.skidPrev = null; return; }
    const spd = Math.abs(v.speed);
    const skidding = (v.slip > 3 && spd > 4) || v.burnout || (v.controls.handbrake && v.driver && spd > 3) || (v.braking && spd > 13 && v.aLong < -13);
    if (!skidding) { v.skidPrev = null; return; }
    const ws = v.def.wheels;
    const rear = v.rearIdx || (v.rearIdx = ws.map((w, i) => (w.rear ? i : -1)).filter((i) => i >= 0));
    if (!v.skidPrev) v.skidPrev = new Float32Array(rear.length * 2).fill(NaN);
    const y = v.position.y + 0.025;
    for (let k = 0; k < rear.length; k++) {
      const w = ws[rear[k]];
      v.localToWorld(w.x, 0, w.z, _v);
      const px = v.skidPrev[k * 2], pz = v.skidPrev[k * 2 + 1];
      if (Number.isNaN(px)) { v.skidPrev[k * 2] = _v.x; v.skidPrev[k * 2 + 1] = _v.z; continue; }
      const dx = _v.x - px, dz = _v.z - pz, len = Math.hypot(dx, dz);
      if (len > 4) { v.skidPrev[k * 2] = _v.x; v.skidPrev[k * 2 + 1] = _v.z; continue; }
      if (len > 0.3) {
        this._addSkid((px + _v.x) / 2, y, (pz + _v.z) / 2, Math.atan2(dx, dz), len + 0.04, w.w * 0.85);
        v.skidPrev[k * 2] = _v.x; v.skidPrev[k * 2 + 1] = _v.z;
      }
      if (v.distSq < 50 * 50 && Math.random() < dt * 22) {
        _v.y = v.position.y + 0.1;
        try { g.fx?.dust?.(_v, { amount: v.burnout ? 1.2 : 0.6, color: 0xd8d8d8 }); } catch (e) { /* ignore */ }
      }
    }
  }

  /** Exhaust puffs when launching and dust clouds behind the wheels on grass / dirt / sand. */
  _trails(v, dt) {
    const g = this.game, fx = g.fx;
    if (!fx) return;
    const spd = Math.abs(v.speed), thr = v.controls.throttle || 0;
    if (thr > 0.7 && spd < 7 && Math.random() < dt * 9) {
      const e = v.meta.exhaust;
      if (e) { v.localToWorld(e.x, e.y + 0.05, e.z - 0.1, _v); try { fx.dust?.(_v, { amount: 0.6, color: e.up ? 0x3a3a3a : 0x9a9a9a }); } catch (err) { /* ignore */ } }
    }
    if (v.surfGrip < 0.9 && spd > 7 && Math.random() < dt * Math.min(18, spd * 0.7)) {
      const ws = v.def.wheels;
      const w = ws[ws.length - 1 - Math.floor(Math.random() * Math.min(2, ws.length))];
      v.localToWorld(w.x, 0.1, w.z - 0.3 * Math.sign(v.speed || 1), _v);
      try { fx.dust?.(_v, { amount: 1, color: v.surfGrip < 0.72 ? 0xd9cb92 : 0x8f7552 }); } catch (err) { /* ignore */ }
    }
  }

  _addSkid(x, y, z, yaw, len, width) {
    const sk = this._skid;
    if (!sk) return;
    const i = this._skidN % SKID_MAX;
    this._skidN++;
    _q.setFromAxisAngle(_ey, yaw);
    _sc.set(width, 1, len);
    _m.compose(_v2.set(x, y, z), _q, _sc);
    sk.setMatrixAt(i, _m);
    sk.instanceMatrix.needsUpdate = true;
    sk.count = Math.min(this._skidN, SKID_MAX);
    sk.visible = true;
  }

  // ---------------------------------------------------------------- bike rider
  _updateRider(v, dt) {
    let rider = this._riders.get(v);
    const want = !!v.driver && !v.destroyed;
    if (!want) { if (rider) { rider.dispose(); this._riders.delete(v); } return; }
    if (!rider) {
      const p = this.game.player;
      const look = v.driver === 'player' && p && p.humanoid ? p.humanoid.look : (v.riderLook || LOOKS.gang);
      rider = new Humanoid(look);
      const d = v.meta.driver || { x: 0, y: 0.82, z: -0.25 };
      rider.root.position.set(d.x, d.y - 0.68, d.z);
      rider.root.rotation.x = 0.32;
      v.bodyGroup.add(rider.root);
      this._riders.set(v, rider);
    }
    rider.root.visible = !(v === this._player && this._hoodCam());
    rider.animate(dt, { state: 'sit', speed: 0 });
    // feet toward the pegs, arms to the bars
    rider.legL.rotation.x = rider.legR.rotation.x = -1.15;
    rider.armL.rotation.x = rider.armR.rotation.x = -1.25;
    rider.head.rotation.x = -0.25;
  }

  // ---------------------------------------------------------------- audio
  _startPlayerEngine(v) {
    const g = this.game;
    if (this._pEngine) { try { this._pEngine.stop(); } catch (e) { /* ignore */ } }
    this._stopHandle(this._engines, v);
    this._pEngine = g.audio?.createEngine?.(v.def.engine || 'car') || null;
  }

  _audio(dt, focus) {
    const g = this.game, au = g.audio;
    if (!au) return;
    const pv = this._player;
    if (pv && this._pEngine) {
      const thr = pv.isHeli ? Math.max(Math.abs(pv.controls.throttle), Math.abs(pv.controls.lift)) : Math.abs(pv.controls.throttle);
      const rpm = pv.isHeli ? pv.rotor * (0.85 + 0.15 * thr) : pv.rpm;
      try { this._pEngine.update(pv.destroyed ? 0 : rpm, pv.flooded ? 0 : thr, pv.position); } catch (e) { /* ignore */ }
    }
    // tyre screech (player)
    const corner = pv && pv.cornerLoad > 0.93 && Math.abs(pv.speed) > 12;
    const slide = pv && !pv.isHeli && pv.onGround && !pv.destroyed && !pv.inWater && ((pv.slip > 3.4 && Math.abs(pv.speed) > 5) || pv.burnout ||
      corner || (pv.braking && Math.abs(pv.speed) > 12 && (pv.controls.handbrake || pv.aLong < -15)));
    if (slide) {
      if (!this._screech && au.loop) this._screech = au.loop('tire_screech', { position: pv.position, volume: 0.1 }) || null;
      if (this._screech) {
        this._screech.setVolume?.(clamp((pv.slip - 2.5) / 7 + (pv.burnout ? 0.6 : 0) + (pv.braking ? 0.25 : 0) + (corner ? 0.3 : 0), 0.2, 1));
        this._screech.setPosition?.(pv.position);
      }
    } else if (this._screech) { try { this._screech.stop(); } catch (e) { /* ignore */ } this._screech = null; }
    // nearest AI engines (max 3 within 40 m)
    this._engineT -= dt;
    if (this._engineT <= 0 && au.createEngine) {
      this._engineT = 0.5;
      const want = this.list.filter((v) => v !== pv && v.driver && !v.destroyed && !v.frozen && v.distSq < 40 * 40)
        .sort((a, b) => a.distSq - b.distSq).slice(0, 3);
      for (const [v] of this._engines) if (!want.includes(v)) this._stopHandle(this._engines, v);
      for (const v of want) if (!this._engines.has(v)) { const h = au.createEngine(v.def.engine || 'car'); if (h) this._engines.set(v, h); }
    }
    for (const [v, h] of this._engines) {
      const rpm = v.isHeli ? v.rotor : v.rpm;
      try { h.update(rpm, Math.abs(v.controls.throttle || 0), v.position); } catch (e) { /* ignore */ }
    }
    // player-toggled sirens follow their car
    for (const [v, h] of this._sirens) {
      if (!v.sirenOn || v.destroyed || v.removed) { this._stopHandle(this._sirens, v); continue; }
      h.setPosition?.(v.position);
    }
    for (const [v, h] of this._alarms) {
      if (v.alarmT <= 0 || v.destroyed || v.removed) { this._stopHandle(this._alarms, v); continue; }
      h.setPosition?.(v.position);
    }
    // burning vehicles crackle (nearest few)
    for (const v of this.list) {
      const burning = (v.onFire || (v.destroyed && v.fireHandle && v.destroyedT < 12)) && v.distSq < 45 * 45;
      const h = this._fireLoops.get(v);
      if (burning && !h && au.loop && this._fireLoops.size < 3) this._fireLoops.set(v, au.loop('fire', { position: v.enginePos, volume: 0.8 }));
      else if (!burning && h) this._stopHandle(this._fireLoops, v);
      else if (h) h.setPosition?.(v.enginePos);
    }
  }

  _startAlarm(v, seconds) {
    const au = this.game.audio;
    v.alarmT = seconds;
    if (!au || !au.loop || this._alarms.has(v)) return;
    const h = au.loop('car_alarm', { position: v.position, volume: 0.9 });
    if (h) this._alarms.set(v, h);
  }

  _stopHandle(map, v) {
    const h = map.get(v);
    if (!h) return;
    try { h.stop(); } catch (e) { /* ignore */ }
    map.delete(v);
  }

  /** Red/blue glow for the nearest siren-on vehicle within 60 m at night: short pulses of the pooled fx lights. */
  _updateSirenLight(focus, dt) {
    const g = this.game;
    this._sirenPulseT -= dt;
    if (this._sirenPulseT > 0) return;
    const night = g.sky ? g.sky.nightFactor || 0 : 0;
    if (night <= 0.2 || !g.fx || typeof g.fx.flash !== 'function') { this._sirenPulseT = 0.25; return; }
    let best = null, bd = 60 * 60;
    for (const v of this.list) {
      if (!v.sirenOn || v.destroyed || v.isHeli || v.frozen) continue;
      const d = (v.position.x - focus.x) ** 2 + (v.position.z - focus.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    if (!best) { this._sirenPulseT = 0.2; return; }
    this._sirenPulseT = 0.12;
    this._sirenSide = !this._sirenSide;
    const left = this._sirenSide;
    best.localToWorld(left ? 0.5 : -0.5, best.def.size.h + 0.45, -0.3, _v);
    // each pulse ends before the next one starts, so the strobe only ever holds one of the pooled lights
    try {
      g.fx.flash(_v, { color: left ? 0xff2a22 : 0x2f62ff, intensity: 80 * clamp((night - 0.2) / 0.4, 0, 1), distance: 16, duration: 0.11, priority: 1 });
    } catch (e) { /* fx stub */ }
  }

  _updateSpot() {
    const g = this.game, sp = this._spot;
    if (!sp) return;
    const pv = this._player;
    const night = g.sky ? g.sky.nightFactor || 0 : 0;
    if (!pv || !pv.lightsOn || pv.destroyed || night < 0.25) { sp.intensity = 0; return; }
    const k = clamp((night - 0.25) / 0.4, 0, 1);
    const s = Math.sin(pv.yaw), c = Math.cos(pv.yaw);
    if (pv.isHeli) {
      pv.localToWorld(0, 0.4, pv.def.size.l * 0.3, _v);
      sp.position.copy(_v);
      this._spotTarget.position.set(_v.x + s * 14, _v.y - 20, _v.z + c * 14);
      sp.angle = 0.42;
      sp.distance = 70;
      sp.intensity = 260 * k;
    } else {
      pv.localToWorld(0, Math.min(1.1, pv.def.size.h * 0.55), pv.def.size.l / 2 + 0.2, _v);
      sp.position.copy(_v);
      this._spotTarget.position.set(_v.x + s * 22, _v.y - 1.6, _v.z + c * 22);
      sp.angle = 0.55;
      sp.distance = 55;
      sp.intensity = 150 * k;
    }
    this._spotTarget.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- streaming / cleanup
  _canDespawn(v) {
    if (v.persistent || v === this._player || v.driver === 'player') return false;
    if (v === this._lastPlayerVehicle && v.distSq < 300 * 300) return false;
    if (v.destroyed) return true;
    return !v.ai && v.driver !== 'ai';
  }

  _cleanup(focus) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      if (!v) continue;
      const d2 = (v.position.x - focus.x) ** 2 + (v.position.z - focus.z) ** 2;
      v.distSq = d2;
      if (v.destroyed && !v.persistent && v !== this._lastPlayerVehicle) {
        if ((v.destroyedT > 60 && d2 > 60 * 60) || d2 > DESPAWN_RADIUS * DESPAWN_RADIUS) {
          if (v.ai) { try { v.ai.release?.(v); } catch (e) { /* ignore */ } v.ai = null; }
          this.remove(v);
        }
        continue;
      }
      if (d2 > DESPAWN_RADIUS * DESPAWN_RADIUS && this._canDespawn(v)) this.remove(v);
    }
    // too many wrecks: drop the oldest far ones
    const wrecks = this.list.filter((v) => v.destroyed && !v.persistent && v !== this._lastPlayerVehicle);
    if (wrecks.length > 10) {
      wrecks.sort((a, b) => b.destroyedT - a.destroyedT);
      for (const v of wrecks.slice(0, wrecks.length - 10)) if (v.distSq > 30 * 30) this.remove(v);
    }
  }

  _inView(x, y, z) {
    const cam = this.game.camera;
    if (!cam) return false;
    cam.getWorldDirection(_v);
    _v2.set(x - cam.position.x, y + 1 - cam.position.y, z - cam.position.z);
    const d = _v2.length();
    if (d < 1e-3) return true;
    return _v.dot(_v2) / d > 0.35 && d < 100;
  }

  _streamParked(initial) {
    const g = this.game, plan = g.generator && g.generator.plan, world = g.world;
    if (!plan || !world) return;
    const focus = this._focus(_v2).clone();
    const spots = plan.parkingSpots || [];
    for (const [i, v] of this._spots) {
      const s = spots[i];
      if (!s || v.removed || Math.hypot(v.position.x - s.x, v.position.z - s.z) > 4) this._spots.delete(i);
    }
    let parked = 0;
    for (const v of this.list) if (v.parked && !v.destroyed) parked++;
    if (parked < PARK_MAX) {
      const cands = [];
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if (this._spots.has(i)) continue;
        const d = Math.hypot(s.x - focus.x, s.z - focus.z);
        if (d > PARK_RADIUS) continue;
        if (!initial && (d < 40 || this._inView(s.x, s.y || focus.y, s.z))) continue;
        cands.push([d, i]);
      }
      cands.sort((a, b) => a[0] - b[0]);
      let spawned = 0;
      for (const [, i] of cands) {
        if (parked >= PARK_MAX || spawned >= (initial ? PARK_MAX : 2)) break;
        const s = spots[i];
        if (!initial && typeof world.isMeshedAt === 'function' && !world.isMeshedAt(s.x, s.z)) continue;
        if (this.findNearest(s, 3.2)) continue;
        const type = parkedTypeForTag(s.tag);
        const y = this._groundAt(s.x, s.z, Number.isFinite(s.y) ? s.y + 3 : undefined);
        if (!this._spotFree(s.x, y, s.z, VEHICLE_TYPES[type])) continue;
        const v = this.spawn(type, s.x, y, s.z, s.yaw || 0, { parked: true, owned: s.tag === 'safehouse' });
        if (!v) continue;
        v.spotIndex = i;
        v.sleeping = true;
        v.sleepCheck = 0.3 + Math.random() * 0.4;
        this._spots.set(i, v);
        parked++; spawned++;
      }
    }
    this._helipad(initial, focus);
  }

  _helipad(initial, focus) {
    const g = this.game, plan = g.generator && g.generator.plan;
    const pads = plan && typeof plan.poisOfType === 'function' ? plan.poisOfType('helipad') : [];
    const pad = pads && pads[0];
    if (!pad) return;
    const d = Math.hypot(pad.x - focus.x, pad.z - focus.z);
    const h = this._padHeli;
    const present = h && !h.removed && !h.destroyed && Math.hypot(h.position.x - pad.x, h.position.z - pad.z) < 10;
    if (present || d > 170) return;
    if (h && !h.removed && !h.destroyed && h.driver) return;
    if (!initial && (d < 45 || this._inView(pad.x, pad.y || 28, pad.z))) return;
    if (this.findNearest(pad, 6)) return;
    const y = g.world.findGround(pad.x, pad.z, 80);
    if (!(y > 0)) return;
    const v = this.spawn('heli', pad.x, y, pad.z, (pad.yaw || 0) + Math.PI, { parked: true });
    if (v) { v.sleeping = true; this._padHeli = v; }
  }

  _spotFree(x, y, z, def) {
    const w = this.game.world;
    if (!w || !Number.isFinite(y)) return false;
    const hw = Math.max(def.size.w, def.size.l) * 0.32;
    if (boxCollides(w, x, y + 1.06, z, hw, Math.max(0.5, Math.min(def.size.h, 2.5) - 1.1))) return false;
    for (const o of this.list) {
      if (Math.abs(o.position.x - x) < (o.boundR + def.size.l * 0.5) && Math.abs(o.position.z - z) < (o.boundR + def.size.l * 0.5) &&
        Math.hypot(o.position.x - x, o.position.z - z) < o.boundR + Math.max(def.size.w, def.size.l) * 0.45) return false;
    }
    return true;
  }

  /** Standing height at (x, z): first solid block scanning down from fromY (default: plan surface + a margin). */
  _groundAt(x, z, fromY) {
    const g = this.game, w = g.world, plan = g.generator && g.generator.plan;
    let start = fromY;
    if (!Number.isFinite(start)) {
      const sy = plan && typeof plan.surfaceY === 'function' ? plan.surfaceY(x, z) : WORLD.CITY_LEVEL;
      start = (Number.isFinite(sy) ? sy : WORLD.CITY_LEVEL) + 3;
    }
    if (w && typeof w.findGround === 'function') {
      const y = w.findGround(x, z, Math.floor(start));
      if (y > 0) return y;
      const top = w.findGround(x, z);
      if (top > 0) return top;
    }
    return WORLD.CITY_LEVEL;
  }

  /** Minimap blips: vehicles with a `blip` object (missions), drawn as car icons. */
  getBlips(out) {
    for (const v of this.list) {
      if (!v.blip || v.destroyed || v === this._player) continue;
      const b = v.blip;
      out.push({ x: v.position.x, z: v.position.z, color: b.color || '#3fa9ff', shape: b.shape || 'square', size: b.size || 7, icon: 'car', label: b.label, edge: b.edge !== false, flash: !!b.flash });
    }
  }

  // ============================================================================================ debug
  _installDebug() {
    const g = this.game, d = g.debug, self = this;
    if (!d) return;
    /** Spawn a vehicle ~6 m in front of the player (facing the same way). */
    d.spawnCar = (type = 'sports', opts = {}) => {
      const p = g.player;
      const yaw = g.cameraRig ? g.cameraRig.yaw : (p ? p.yaw : 0);
      const px = p ? p.position.x : 256, pz = p ? p.position.z : 256;
      const def = VEHICLE_TYPES[type] || VEHICLE_TYPES.sedan;
      const dist = def.size.l / 2 + 2.2;
      const x = px + Math.sin(yaw) * dist, z = pz + Math.cos(yaw) * dist;
      const y = p ? self._groundAt(x, z, p.position.y + 3) : undefined;
      return self.spawn(type, x, y, z, yaw, opts);
    };
    /** Enter the nearest vehicle within 12 m. */
    d.enterNearest = (maxDist = 12) => {
      const p = g.player;
      if (!p) return false;
      const v = self.findNearest(p.position, maxDist, (x) => !x.destroyed);
      return v ? self.enter(v, { quiet: true, force: true }) : false;
    };
    d.exitVehicle = () => self.exit();
    /** Snapshot of the player's (or given) vehicle. */
    d.vehicleState = (v) => {
      v = v || self._player || self._lastPlayerVehicle;
      if (!v) return null;
      return {
        type: v.type, pos: v.position.toArray().map((n) => +n.toFixed(2)), yaw: +v.yaw.toFixed(3), speed: +v.speed.toFixed(2),
        vel: v.velocity.toArray().map((n) => +n.toFixed(2)), yawRate: +v.yawRate.toFixed(3), slip: +v.slip.toFixed(2),
        health: +v.health.toFixed(1), destroyed: v.destroyed, onFire: v.onFire, onGround: v.onGround, inWater: v.inWater,
        flooded: v.flooded, rotor: +v.rotor.toFixed(2), driver: v.driver, sleeping: v.sleeping, rpm: +v.rpm.toFixed(2),
        pitch: +v.pitch.toFixed(3), roll: +v.roll.toFixed(3), lightsOn: v.lightsOn, sirenOn: v.sirenOn,
      };
    };
    d.vehicles = () => self.list.map((v) => ({ type: v.type, x: +v.position.x.toFixed(1), y: +v.position.y.toFixed(1), z: +v.position.z.toFixed(1), driver: v.driver, parked: v.parked, destroyed: v.destroyed, sleeping: v.sleeping }));
    d.repairCar = () => { const v = self._player || self._lastPlayerVehicle; if (v) v.repair(); return !!v; };
    d.destroyCar = (v) => { v = v || self._player || self._lastPlayerVehicle; if (v) self.explodeVehicle(v, null); return !!v; };
    d.godCar = (on = true) => { self.godVehicle = !!on; return self.godVehicle; };
    /** Spawn one of every type in a row beside the player (for screenshots). */
    d.spawnRow = (types = VEHICLE_TYPE_IDS, gap = 1.6) => {
      const p = g.player;
      const yaw = g.cameraRig ? g.cameraRig.yaw : 0;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      const rx = -c, rz = s;
      let off = 0;
      const out = [];
      for (const t of types) {
        const def = VEHICLE_TYPES[t];
        if (!def) continue;
        off += def.size.w / 2 + (def.kind === 'heli' ? def.rotorRadius - def.size.w / 2 : 0);
        const x = p.position.x + s * 12 + rx * off, z = p.position.z + c * 12 + rz * off;
        out.push(self.spawn(t, x, self._groundAt(x, z, p.position.y + 3), z, yaw + Math.PI / 2, { parked: true }));
        off += def.size.w / 2 + gap + (def.kind === 'heli' ? def.rotorRadius - def.size.w / 2 : 0);
      }
      return out.length;
    };
  }
}
