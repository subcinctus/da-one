// Peds (ARCHITECTURE.md §Peds, NPC agent): ~30 pedestrians bringing the streets to life.
//
//   - spawns humanoids (randomLook) 35-90 m from the player, out of view when possible, on the sidewalk graph
//     (denser downtown), strolling in parks / plazas / on the beach, sparse hikers in the countryside;
//     despawns them beyond ~110 m (persistent mission peds excepted)
//   - walking with random turns at corners, crossing at crosswalks when no car is close, idling, phone calls,
//     chatting in pairs, glancing at the player
//   - reactions: gunfire / explosions / deaths nearby -> panic; a gun aimed at them -> hands up, then run;
//     punched -> 30% fight back; speeding cars -> dive aside; the player driving on the sidewalk -> scatter
//   - gang turf (Port Anvil + Ironworks): ~30% of peds are armed gang members who turn hostile when the player
//     attacks or aims at any of them, and shoot back via game.combat.fire, keeping 8-15 m away
//   - deaths drop cash (pickups.spawn('cash')), bodies despawn after 20 s
//
// Public API: list, spawnPed(pos, opts), panicAt(position, radius, source?), gangAggro(position, radius, target),
// remove(ped), stats(), rollPlayerHit(p) (shared gang hit governor). Debug: game.debug.spawnPeds(n), npcStats(), pedInfo(), spawnGang(n), gangAggro().
import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { B } from '../world/blocks.js';
import { getNav } from './nav.js';
import { Ped, CALM } from './npc_ped.js';
import {
  isVisible, chunkReady, viewRadius, densityScale, rand, chance, GANG_DISTRICTS, PED_DENSITY, playerHoldsGun,
} from './npc_util.js';

const BUILT_LOTS = new Set(['building', 'tower', 'house', 'shop', 'industrial']);
const STROLL_LOTS = new Set(['park', 'plaza']);
const DESPAWN_R = 110;
/** Gang gunfire on the player: minimum seconds between two landed hits (any shooter), and the accumulator cap. */
const GANG_HIT_GAP = 0.9;
const GANG_HIT_BANK = 1.5;
const _v = new THREE.Vector3();
const _ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
let _pistolGeo = null;

export class Peds {
  constructor(game) {
    this.game = game;
    /** All live pedestrians (Ped instances, also registered in game.entities). */
    this.list = [];
    this.nav = null;
    this.enabled = true;
    this.stats = { spawned: 0, despawned: 0, deaths: 0, dodges: 0, fights: 0, aggro: 0, panics: 0, failedSpawns: 0, gangShots: 0, gangHits: 0 };
    // shared hit governor for gang gunfire on the player (see rollPlayerHit)
    this._hitAcc = 0;
    this._lastHitT = -1e9;
    this._lastShotT = -1e9;
    this._nearEdges = [];
    this._nearLots = [];
    this._ruralFrac = 0;
    this._nearT = 0;
    this._spawnCd = 0;
    this._percT = 0;
    this._sidewalkT = 0;
    this._fill = true;
    this._weaponSrc = null;
    this._ms = 0;
    this._msMax = 0;
  }

  init() {
    const g = this.game;
    const plan = g.generator && g.generator.plan;
    if (!plan || !plan.nodes) return;
    this.nav = getNav(plan);
    const ev = g.events;
    ev.on('gunfire', (e) => {
      if (!e || !e.position) return;
      this.panicAt(e.position, 30, e.shooter || null, null, 0.45);
    });
    ev.on('explosion', (e) => {
      if (!e || !e.position) return;
      this.panicAt(e.position, 30 + (e.radius || 4) * 2, null, null, 0.3);
      if (e.source === g.player) this.gangAggro(e.position, 40, g.player);
    });
    ev.on('entityKilled', (e) => {
      const ent = e && e.entity;
      if (!ent || ent.kind === 'ped' || !ent.position) return; // ped deaths are handled in onPedDeath
      if (ent.kind === 'player' || ent.kind === 'cop') this.panicAt(ent.position, 24, e.info && e.info.source, null, 0.3);
    });
    ev.on('entityDamaged', (e) => {
      const ent = e && e.entity, info = e && e.info;
      if (!ent || ent.kind === 'ped' || !info) return;
      // the player beating up / shooting a cop: bystanders run
      if (ent.kind === 'cop' && info.source === g.player) this.panicAt(ent.position, 14, g.player, null, 0);
    });
    ev.on('playerRespawned', () => { this._fill = true; this._hitAcc = 0; });
    this._installDebug();
    try { this._initialFill(true); } catch (e) { console.warn('[peds] initial fill failed', e); }
  }

  // ============================================================================================ public API

  /**
   * Spawn a pedestrian (missions: targets / bodyguards; traffic: drivers leaving their car).
   * opts: {look, mood: 'calm'|'flee'|'fight', team: 'civilian'|'gang', weapon: 'pistol'|..., health, target (entity to
   * fight / flee from, default player), persistent (default true: never despawned by distance; call remove()),
   * mode: 'walk'|'wander'|'guard' (default: guard for persistent peds, sidewalk walking otherwise), yaw, wanderR,
   * knocked (start on the ground)}. Returns the Ped.
   */
  spawnPed(pos, opts = {}) {
    const g = this.game;
    if (!pos) return null;
    const o = { ...opts };
    if (o.persistent === undefined) o.persistent = true;
    if (!o.mode) o.mode = o.persistent ? (o.wanderR ? 'wander' : 'guard') : 'walk';
    if (o.mood === 'fight' && !o.target) o.target = g.player;
    if (o.team === 'gang' && o.weapon === undefined) o.weapon = 'pistol';
    const p = _v.set(Number(pos.x) || 0, Number(pos.y), Number(pos.z) || 0);
    if (!Number.isFinite(p.y)) p.y = this._groundAt(p.x, p.z, 60);
    return this._add(p, o);
  }

  /**
   * Decide whether one gang shot at the player with probability p lands. Shared by every armed ped (modelled on
   * Police.rollHit): a pseudo-random accumulator spreads hits evenly (no lucky streaks) and at least GANG_HIT_GAP
   * seconds separate two hits, so three gangsters land at most ~1 hit/s instead of bursts that kill in a few seconds.
   */
  rollPlayerHit(p) {
    const now = this.game.time || 0;
    this.stats.gangShots++;
    this._lastShotT = now;
    this._hitAcc = Math.min(GANG_HIT_BANK, this._hitAcc + Math.max(0, Number(p) || 0));
    if (this._hitAcc < 0.55 + Math.random() * 0.45) return false;
    if (now - this._lastHitT < GANG_HIT_GAP) return false;
    this._hitAcc = Math.max(0, this._hitAcc - 1);
    this._lastHitT = now;
    this.stats.gangHits++;
    return true;
  }

  /** Remove a pedestrian immediately (missions cleaning up their targets). */
  remove(ped) {
    const i = this.list.indexOf(ped);
    if (i >= 0) this.list.splice(i, 1);
    if (!ped || ped.removed) return;
    this.game.entities.remove(ped);
    ped.dispose();
    this.stats.despawned++;
  }

  /**
   * Panic every pedestrian within `radius` of `position` (gunfire, explosions, deaths). Gang members instead turn on
   * the player when the source is the player. startle: seconds of hands-up fright before running.
   */
  panicAt(position, radius = 30, source = null, except = null, startle = 0) {
    if (!position) return;
    const g = this.game;
    const r2 = radius * radius;
    let n = 0;
    for (const p of this.list) {
      if (!p.alive || p === except || p.removed) continue;
      const dx = p.position.x - position.x, dz = p.position.z - position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      if (p.team === 'gang' || (p.weapon && p.persistent)) {
        // gang members do not run: they turn on the player
        if (source && source === g.player && d2 < 38 * 38 && !((p.state === 'shoot' || p.state === 'fight') && p.target === source)) {
          if (p.weapon) p.startShoot(source); else p.startFight(source);
          this.stats.aggro++;
        }
        continue;
      }
      if ((p.state === 'fight' || p.state === 'shoot') && p.target) continue;
      if (p.state === 'knocked' || p.state === 'dive') { p.afterKnock = 'flee'; p.threatX = position.x; p.threatZ = position.z; continue; }
      const thr = source && source.position && source !== p ? source : null;
      p.startFlee(position.x, position.z, thr, rand(8, 12), p.state === 'flee' ? 0 : startle * rand(0.6, 1.3));
      n++;
    }
    if (n) this.stats.panics++;
  }

  /** Gang members (and armed mission peds) within `radius` of `position` attack `target`. */
  gangAggro(position, radius, target, only = null) {
    if (!target || target.alive === false || target.team === 'gang') return;
    const r2 = radius * radius;
    let n = 0;
    for (const p of this.list) {
      if (!p.alive || p.removed) continue;
      if (only && p !== only) continue;
      if (p.team !== 'gang' && !(p.weapon && p.persistent)) continue;
      const dx = p.position.x - position.x, dz = p.position.z - position.z;
      if (!only && dx * dx + dz * dz > r2) continue;
      if ((p.state === 'shoot' || p.state === 'fight') && p.target === target) { p.lostT = 0; continue; }
      if (p.weapon) p.startShoot(target); else p.startFight(target);
      n++;
    }
    if (n) {
      this.stats.aggro++;
      // civilians around a shootout scatter
      this.panicAt(position, Math.max(radius, 20), target, null, 0.3);
    }
  }

  /** Aggregate statistics (also game.debug.npcStats()). */
  pedStats() {
    const states = {};
    let gang = 0, hostile = 0, persistent = 0;
    for (const p of this.list) {
      states[p.state] = (states[p.state] || 0) + 1;
      if (p.team === 'gang') gang++;
      if (p.state === 'shoot' || (p.state === 'fight' && p.target === this.game.player)) hostile++;
      if (p.persistent) persistent++;
    }
    return { peds: this.list.length, target: this._target(), states, gang, hostile, persistent, msAvg: +this._ms.toFixed(3), msMax: +this._msMax.toFixed(2), ...this.stats };
  }

  // ============================================================================================ update

  update(dt) {
    const t0 = performance.now();
    // the gang hit accumulator bleeds off during lulls (no banked hit when the player leaves cover)
    if (this._hitAcc > 0 && (this.game.time || 0) - this._lastShotT > 2) this._hitAcc = Math.max(0, this._hitAcc - dt * 0.3);
    this._update(dt);
    const ms = performance.now() - t0;
    this._ms += (ms - this._ms) * 0.05;
    if (ms > this._msMax) this._msMax = ms;
  }

  _update(dt) {
    const g = this.game;
    if (!this.nav || !this.enabled) return;
    const player = g.player;
    const focus = player && player.position ? player.position : g.camera.position;
    const R = viewRadius(g);
    const simR = Math.min(80, R - 6);
    const simR2 = simR * simR;
    const visR2 = (R + 4) * (R + 4);

    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.removed) { this.list.splice(i, 1); continue; }
      const dx = p.position.x - focus.x, dz = p.position.z - focus.z;
      const d2 = dx * dx + dz * dz;
      if (p.state === 'dead' && p.deadT > 20) { this.remove(p); continue; }
      if (!p.persistent) {
        if (d2 > DESPAWN_R * DESPAWN_R || p.position.y < 1) { this.remove(p); continue; }
        if (p.waterT > 8 && !isVisible(g, p.position.x, p.position.y + 1, p.position.z, 1.5)) { this.remove(p); continue; }
      } else if (d2 > 140 * 140) {
        // far-away mission peds sleep (and stay hidden) until the player comes back
        p.humanoid.root.visible = false;
        continue;
      }
      p.humanoid.root.visible = d2 < visR2;
      p.update(dt, d2, d2 < simR2 && chunkReady(g, p.position.x, p.position.z));
    }
    this._separate();

    // perception: guns aimed at people, cars on the sidewalk
    this._percT -= dt;
    if (this._percT <= 0) { this._percT = 0.16; this._perceive(); }

    // spawning
    this._nearT -= dt;
    if (this._nearT <= 0) { this._nearT = 1.5; this._refreshNearEdges(focus); }
    if (this._fill) { this._fill = false; this._initialFill(false); }
    this._spawnCd -= dt;
    if (this._spawnCd <= 0) {
      const ambient = this._ambientCount();
      if (ambient < this._target()) {
        const ok = this._trySpawn(focus, false);
        this._spawnCd = ok ? rand(0.12, 0.3) : 0.35;
      } else this._spawnCd = 0.5;
    }
  }

  _ambientCount() {
    let n = 0;
    for (const p of this.list) if (!p.persistent) n++;
    return n;
  }

  _target() {
    const g = this.game;
    const p = g.player && g.player.position;
    const plan = g.generator && g.generator.plan;
    let dens = 1;
    if (p && plan) {
      const id = plan.districtAt ? plan.districtAt(p.x, p.z).id : '';
      dens = PED_DENSITY[id] !== undefined ? PED_DENSITY[id] : plan.isCity && plan.isCity(p.x, p.z) ? 1 : 0.22;
    }
    const night = g.sky ? g.sky.nightFactor || 0 : 0;
    const n = 27 * densityScale(g) * dens * (1 - 0.4 * night);
    return Math.round(Math.max(5, Math.min(38, n)));
  }

  /** Gentle separation between peds and from the player (no two people in the same spot). */
  _separate() {
    const L = this.list, n = L.length;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      if (!a.alive || a.state === 'knocked' || !a.humanoid.root.visible) continue;
      for (let j = i + 1; j < n; j++) {
        const b = L[j];
        if (!b.alive || b.state === 'knocked') continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.42 || d2 < 1e-6 || Math.abs(a.position.y - b.position.y) > 1.5) continue;
        const d = Math.sqrt(d2), push = (0.65 - d) * 0.25;
        const nx = dx / d, nz = dz / d;
        a.position.x -= nx * push; a.position.z -= nz * push;
        b.position.x += nx * push; b.position.z += nz * push;
      }
    }
    const pl = this.game.player;
    if (pl && pl.alive !== false && !pl.hidden) {
      const pv = pl.velocity;
      const pSpeed = pv ? Math.hypot(pv.x, pv.z) : 0;
      const t = this.game.time;
      for (const a of L) {
        if (!a.alive || a.state === 'knocked') continue;
        const dx = a.position.x - pl.position.x, dz = a.position.z - pl.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.42 || d2 < 1e-6 || Math.abs(a.position.y - pl.position.y) > 1.5) continue;
        const d = Math.sqrt(d2), push = (0.65 - d) * 0.5;
        a.position.x += (dx / d) * push; a.position.z += (dz / d) * push;
        // the player barged into someone at a run: they stumble, some get angry, some scurry off
        if (pSpeed > 4.5 && t > (a.bumpedT || 0) && CALM.has(a.state)) {
          a.bumpedT = t + 2.5;
          a.velocity.x += (dx / d) * 3; a.velocity.z += (dz / d) * 3;
          a.flinchT = 0.25;
          if (a.team !== 'gang' && chance(0.12)) { a.startFight(pl); this.stats.fights++; }
          else if (a.team === 'gang' && chance(0.25)) this.gangAggro(a.position, 12, pl);
          else if (chance(0.3)) a.startFlee(pl.position.x, pl.position.z, null, rand(2, 4));
        }
      }
    }
  }

  _perceive() {
    const g = this.game, pl = g.player;
    if (!pl || pl.alive === false) return;
    // ---- a gun pointed at people
    if (!pl.inVehicle && pl.aiming && playerHoldsGun(g, WEAPONS) && g.cameraRig && typeof g.cameraRig.getAimRay === 'function') {
      const ray = g.cameraRig.getAimRay(_ray);
      for (const p of this.list) {
        if (!p.alive) continue;
        const dx = p.position.x - pl.position.x, dz = p.position.z - pl.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 28 * 28) { p.aimedT = 0; continue; }
        const cx = p.position.x - ray.origin.x, cy = p.position.y + 1.2 * p.scale - ray.origin.y, cz = p.position.z - ray.origin.z;
        const t = cx * ray.dir.x + cy * ray.dir.y + cz * ray.dir.z;
        const perp2 = cx * cx + cy * cy + cz * cz - t * t;
        const thr = 0.85 + 0.04 * Math.max(0, t);
        if (t < 0 || perp2 > thr * thr) { p.aimedT = Math.max(0, p.aimedT - 0.16); continue; }
        p.aimedT += 0.16;
        if (p.team === 'gang' || (p.weapon && p.persistent)) {
          if (p.aimedT > 0.4) this.gangAggro(p.position, 30, pl);
        } else if (d2 < 12 * 12) {
          if (p.state === 'cower') p.cowerT = Math.max(p.cowerT, 1.2);
          else if (CALM.has(p.state)) p.startCower(pl.position.x, pl.position.z);
        }
      }
    }
    // ---- the player driving on the sidewalk: everyone around scatters
    const pv = pl.inVehicle || (g.vehicles && g.vehicles.playerVehicle);
    this._sidewalkT -= 0.16;
    if (pv && Math.abs(pv.speed || 0) > 3 && this._sidewalkT <= 0) {
      const P = g.generator.plan;
      const hl = pv.def ? pv.def.size.l / 2 : 2.2;
      const fx = pv.position.x + Math.sin(pv.yaw) * hl * Math.sign(pv.speed), fz = pv.position.z + Math.cos(pv.yaw) * hl * Math.sign(pv.speed);
      if (P.isSidewalk(fx, fz) || P.isSidewalk(pv.position.x, pv.position.z)) {
        this._sidewalkT = 0.5;
        this.panicAt(pv.position, 18, pl, null, 0);
      }
    }
  }

  // ============================================================================================ spawning

  _initialFill(init) {
    const g = this.game;
    const focus = g.player && g.player.position ? g.player.position : g.camera.position;
    this._refreshNearEdges(focus);
    const want = this._target();
    let guard = 0;
    while (this._ambientCount() < want && guard++ < want * 3) this._trySpawn(focus, init ? 'init' : 'fill');
  }

  _refreshNearEdges(focus) {
    const out = this._nearEdges;
    out.length = 0;
    const [rMin, rMax0] = this._spawnRange();
    const rMax = rMax0 + 4;
    const P = this.game.generator.plan;
    // parks / plazas in range (strollers) and how much of the spawn ring is open countryside (hikers, beach)
    this._nearLots.length = 0;
    for (const l of P.lots) {
      if (!STROLL_LOTS.has(l.type)) continue;
      const cx = Math.max(l.x0, Math.min(focus.x, l.x1)), cz = Math.max(l.z0, Math.min(focus.z, l.z1));
      if (Math.hypot(cx - focus.x, cz - focus.z) < rMax) this._nearLots.push(l);
    }
    let rural = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, r = k % 2 ? rMin + 8 : rMax0 - 8;
      const x = focus.x + Math.sin(a) * r, z = focus.z + Math.cos(a) * r;
      if (!P.isCity(x, z) && !P.isWater(x, z) && !P.isRoad(x, z)) rural++;
    }
    this._ruralFrac = rural / 24;
    for (const e of this.nav.walk.edges) {
      if (e.kind === 'cross') continue;
      let t = (focus.x - e.ax) * e.dx + (focus.z - e.az) * e.dz;
      t = t < 0 ? 0 : t > e.len ? e.len : t;
      const d = Math.hypot(focus.x - (e.ax + e.dx * t), focus.z - (e.az + e.dz * t));
      if (d < rMax) out.push(e);
    }
  }

  _spawnRange() {
    const R = viewRadius(this.game);
    const rMax = Math.min(90, R - 6);
    return [Math.min(35, rMax - 15), rMax];
  }

  /** One spawn attempt. mode: false (normal, out of view), 'fill' (>= 20 m, any view), 'init' (>= 6 m). */
  _trySpawn(focus, mode) {
    const g = this.game;
    let [rMin, rMax] = this._spawnRange();
    if (mode === 'init') rMin = 6; else if (mode === 'fill') rMin = 20;
    const P = g.generator.plan;
    const edges = this._nearEdges;
    const lots = this._nearLots;
    const pPark = lots.length ? 0.3 : 0;
    const pRural = this._ruralFrac * 0.9;
    for (let attempt = 0; attempt < 12; attempt++) {
      const roll = Math.random();
      const park = roll < pPark;
      const sidewalk = !park && edges.length > 0 && roll >= pPark + pRural;
      let x, z, y, opts;
      let minD = rMin;
      if (park) {
        // strollers roam the whole park / plaza
        const lot = lots[Math.floor(Math.random() * lots.length)];
        x = rand(lot.x0 + 1, lot.x1 - 1); z = rand(lot.z0 + 1, lot.z1 - 1);
        const hx = (lot.x1 - lot.x0) / 2, hz = (lot.z1 - lot.z0) / 2;
        opts = { mode: 'wander', region: lot, anchor: { x: lot.x0 + hx, z: lot.z0 + hz }, wanderR: Math.max(6, Math.min(hx, hz) - 1), persistent: false };
        if (!mode) minD = Math.min(rMin, 22);
      } else if (sidewalk) {
        // two candidates, keep the one closer to the player: sidewalks near the player feel busier
        let e = edges[Math.floor(Math.random() * edges.length)];
        const e2 = edges[Math.floor(Math.random() * edges.length)];
        if (edgeDist(e2, focus) < edgeDist(e, focus)) e = e2;
        const t = rand(0.5, e.len - 0.5);
        const lat = rand(-0.1, 0.6);
        x = e.ax + e.dx * t + e.nx * lat; z = e.az + e.dz * t + e.nz * lat;
        opts = { mode: 'walk', edge: e, edgeT: t, persistent: false };
      } else {
        const a = Math.random() * Math.PI * 2, r = rand(rMin, rMax);
        x = focus.x + Math.sin(a) * r; z = focus.z + Math.cos(a) * r;
        const lot = P.lotAt(x, z);
        if (lot && STROLL_LOTS.has(lot.type)) {
          opts = { mode: 'wander', region: lot, anchor: { x: (lot.x0 + lot.x1) / 2, z: (lot.z0 + lot.z1) / 2 }, wanderR: Math.max(8, Math.min(lot.x1 - lot.x0, lot.z1 - lot.z0) / 2), persistent: false };
        } else if (!P.isCity(x, z)) {
          const beach = P.districtAt(x, z).id === 'beach';
          opts = { mode: 'wander', anchor: { x, z }, wanderR: beach ? 18 : 28, persistent: false };
        } else continue;
      }
      const d = Math.hypot(x - focus.x, z - focus.z);
      if (d < minD || d > rMax) continue;
      if (!chunkReady(g, x, z)) continue;
      y = this.walkable(x, z, sidewalk);
      if (y < 0) continue;
      if (!mode && attempt < 9 && isVisible(g, x, y + 1, z, 1.2)) continue;
      if (this._crowded(x, z, 1.4)) continue;
      // gang turf
      const dist = P.districtAt(x, z).id;
      // 20% of spawns + their 1-2 buddies ~= 30% of the people on gang turf
      const gang = GANG_DISTRICTS.has(dist) && sidewalk && chance(0.2);
      if (gang) { opts.team = 'gang'; opts.weapon = 'pistol'; }
      const ped = this._add(_v.set(x, y, z), opts);
      if (!ped) continue;
      // gang members hang around in small groups; civilians sometimes walk in pairs
      if (gang && chance(0.75)) this._spawnBuddies(ped, chance(0.5) ? 2 : 1, true);
      else if (sidewalk && chance(0.12)) this._spawnBuddies(ped, 1, false);
      return true;
    }
    this.stats.failedSpawns++;
    return false;
  }

  _spawnBuddies(lead, n, gang) {
    const g = this.game;
    for (let k = 0; k < n; k++) {
      const a = lead.yaw + (k === 0 ? 1.3 : -1.3) + rand(-0.3, 0.3);
      const x = lead.position.x + Math.sin(a) * 1.25, z = lead.position.z + Math.cos(a) * 1.25;
      const y = this.walkable(x, z, true);
      if (y < 0 || this._crowded(x, z, 0.8)) continue;
      const b = this._add(_v.set(x, y, z), {
        mode: lead.mode, persistent: false, team: gang ? 'gang' : 'civilian', weapon: gang ? 'pistol' : null,
        edge: lead.edge, edgeT: lead.edge ? (x - lead.edge.ax) * lead.edge.dx + (z - lead.edge.az) * lead.edge.dz : undefined,
      });
      if (!b) continue;
      if (gang || chance(0.6)) { this.startChat(lead, b); lead.idleT = b.idleT = rand(8, 20); }
      else { b.fwd = lead.fwd; b.walkSpeed = lead.walkSpeed; b.setState(lead.state); }
    }
    void g;
  }

  _crowded(x, z, r) {
    for (const p of this.list) {
      const dx = p.position.x - x, dz = p.position.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    const pl = this.game.player;
    if (pl) { const dx = pl.position.x - x, dz = pl.position.z - z; if (dx * dx + dz * dz < 4) return true; }
    return false;
  }

  _add(pos, opts) {
    const g = this.game;
    let ped;
    try { ped = new Ped(this, pos, opts); } catch (e) { console.warn('[peds] spawn failed', e); return null; }
    g.entities.add(ped);
    this.list.push(ped);
    this.stats.spawned++;
    return ped;
  }

  /**
   * Standing height if (x, z) is a place a pedestrian may stand (not road, water, building or inside blocks), else -1.
   * sidewalk: the spot is known to be a sidewalk (skip the lot checks).
   */
  walkable(x, z, sidewalk = false) {
    const g = this.game, P = g.generator.plan, w = g.world;
    if (P.isWater(x, z)) return -1;
    if (!sidewalk) {
      if (P.isRoad(x, z) || (P.isShoulder && P.isShoulder(x, z))) return -1;
      const lot = P.lotAt(x, z);
      if (lot && BUILT_LOTS.has(lot.type)) return -1;
    }
    const y = P.surfaceY(x, z);
    if (!Number.isFinite(y)) return -1;
    if (w) {
      const bx = Math.floor(x), bz = Math.floor(z);
      if (w.isSolid(bx, y, bz) || w.isSolid(bx, y + 1, bz) || !w.isSolid(bx, y - 1, bz)) return -1;
    }
    return y;
  }

  _groundAt(x, z, startY) {
    const w = this.game.world, P = this.game.generator && this.game.generator.plan;
    if (w && typeof w.findGround === 'function') {
      const y = w.findGround(x, z, Math.floor(startY));
      if (y > 0) return y;
    }
    return P ? P.surfaceY(x, z) : 28;
  }

  // ============================================================================================ helpers used by Ped

  /** Third-person weapon model for a ped's hand (combat's model when available, else a small voxel pistol). */
  weaponModel(id) {
    const g = this.game;
    try {
      const m = g.combat && typeof g.combat.getWeaponViewModel === 'function' ? g.combat.getWeaponViewModel(id) : null;
      if (m && m.isObject3D) return m.parent ? m.clone() : m;
    } catch (e) { /* combat stub */ }
    if (!_pistolGeo) {
      const parts = [new THREE.BoxGeometry(0.07, 0.09, 0.26).translate(0, 0.02, 0.1), new THREE.BoxGeometry(0.06, 0.15, 0.07).translate(0, -0.07, 0)];
      _pistolGeo = mergeBoxes(parts);
    }
    return new THREE.Mesh(_pistolGeo, PISTOL_MAT);
  }

  onPedHurt(ped, info) {
    const g = this.game;
    const raw = info.source && info.source !== ped ? info.source : null;
    // a car is not a person: blame its driver if that is the player, otherwise it was an accident
    const isVeh = !!raw && (raw.kind === 'vehicle' || raw.kind === 'heli');
    const person = isVeh ? (raw.driver === 'player' ? g.player : null) : raw;
    if (ped.team === 'gang' || (ped.weapon && ped.persistent)) {
      // friendly fire from the crew (or a fellow mission gunman): flinch and carry on
      if (person && (person.team === ped.team || (person.weapon && person.persistent && person.kind === 'ped'))) return;
      if (person && person.alive !== false && person.position) {
        // the whole crew joins in when one of them is attacked
        if (ped.team === 'gang') this.gangAggro(ped.position, 45, person);
        if (ped.state !== 'knocked') { if (ped.weapon) ped.startShoot(person); else ped.startFight(person); }
        return;
      }
      if (ped.state === 'shoot' || ped.state === 'fight') return; // busy fighting: shrug it off
    }
    if (ped.state === 'fight' && ped.target === person) return;
    const sp = raw && raw.position ? raw.position : info.point || ped.position;
    if (info.type === 'melee' && person && chance(0.3) && ped.health > ped.maxHealth * 0.3) {
      ped.startFight(person);
      this.stats.fights++;
    } else if (ped.state !== 'knocked' && ped.state !== 'dive') {
      ped.startFlee(sp.x, sp.z, person, rand(9, 13), 0);
    } else {
      ped.afterKnock = 'flee'; ped.threatX = sp.x; ped.threatZ = sp.z; ped.threat = person;
    }
    // witnesses
    this.panicAt(ped.position, info.type === 'bullet' ? 24 : 9, person, ped, 0.3);
  }

  onPedDeath(ped, info) {
    const g = this.game;
    this.stats.deaths++;
    const src = info && info.source;
    const pos = ped.position;
    try {
      const amount = ped.team === 'gang' ? 20 + Math.floor(Math.random() * 70) : 5 + Math.floor(Math.random() * 56);
      g.pickups?.spawn?.('cash', new THREE.Vector3(pos.x, pos.y + 0.4, pos.z), amount);
      if (ped.weapon && chance(0.4)) g.pickups?.spawn?.('ammo:' + ped.weapon, new THREE.Vector3(pos.x + 0.6, pos.y + 0.4, pos.z), 12);
    } catch (e) { console.warn('[peds] drop failed', e); }
    const killer = src && (src.kind === 'vehicle' || src.kind === 'heli') ? (src.driver === 'player' ? g.player : null) : src;
    if (ped.team === 'gang' && killer && killer.alive !== false && killer.team !== 'gang') this.gangAggro(pos, 50, killer);
    this.panicAt(pos, 30, killer && killer !== ped ? killer : null, ped, 0.35);
  }

  findChatPartner(ped) {
    for (const o of this.list) {
      if (o === ped || !o.alive || o.partner || o.team !== ped.team || o.chatCd > 0) continue;
      if (o.state !== 'walk' && o.state !== 'idle') continue;
      const dx = o.position.x - ped.position.x, dz = o.position.z - ped.position.z;
      if (dx * dx + dz * dz < 2.6 * 2.6) return o;
    }
    return null;
  }

  startChat(a, b) {
    const t = rand(5, 11);
    a.setState('chat'); b.setState('chat');
    a.partner = b; b.partner = a;
    a.idleT = t; b.idleT = t + rand(-0.5, 0.5);
    a.chatCd = b.chatCd = rand(15, 30);
    a.gesture = Math.random() * 6; b.gesture = Math.random() * 6 + 3;
  }

  /** Choose a new wander goal for a free-roaming ped (validated straight path). */
  pickWanderGoal(ped) {
    const P = this.game.generator.plan, w = this.game.world;
    for (let k = 0; k < 7; k++) {
      const a = Math.random() * Math.PI * 2, r = rand(4, ped.wanderR);
      const x = ped.anchorX + Math.sin(a) * r, z = ped.anchorZ + Math.cos(a) * r;
      if (ped.region && P.lotAt(x, z) !== ped.region) continue;
      if (!chunkReady(this.game, x, z)) continue;
      const y = this.walkable(x, z);
      if (y < 0 || Math.abs(y - ped.position.y) > 5) continue;
      // in parks, prefer the paths for the first tries
      if (ped.region && k < 4 && w) {
        const id = w.getBlock(Math.floor(x), y - 1, Math.floor(z));
        if (id === B.GRASS || id === B.DIRT) continue;
      }
      if (!this._pathOk(ped, x, z, ped.position.y)) continue;
      ped.goalX = x; ped.goalZ = z; ped.hasGoal = true;
      ped.setState('walk');
      return true;
    }
    return false;
  }

  _pathOk(ped, x, z, y0) {
    const dx = x - ped.position.x, dz = z - ped.position.z;
    const L = Math.hypot(dx, dz);
    const n = Math.ceil(L / 1.5);
    let py = y0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const y = this.walkable(ped.position.x + dx * t, ped.position.z + dz * t);
      if (y < 0 || Math.abs(y - py) > 1) return false;
      py = y;
    }
    return true;
  }

  /** Is the ped standing on grass / sand / boardwalk in a park or the countryside (a nice spot to sit)? */
  canSitHere(ped) {
    const w = this.game.world;
    if (!w || ped.mode !== 'wander') return false;
    const id = w.getBlock(Math.floor(ped.position.x), Math.floor(ped.position.y) - 1, Math.floor(ped.position.z));
    return id === B.GRASS || id === B.SAND || id === B.PLANKS;
  }

  /** Push a ped out of any vehicle body it overlaps (parked cars do not push people themselves). */
  pushOutOfVehicles(ped) {
    const list = this.game.vehicles ? this.game.vehicles.list : null;
    if (!list) return;
    const p = ped.position, r = ped.radius;
    for (const o of list) {
      if (o.isHeli && !o.onGround) continue;
      const def = o.def;
      if (!def) continue;
      const dx = p.x - o.position.x, dz = p.z - o.position.z;
      const br = (o.boundR || 3.5) + r;
      if (dx * dx + dz * dz > br * br) continue;
      if (p.y > o.position.y + def.size.h - 0.2 || p.y + ped.height < o.position.y + 0.1) continue;
      const s = Math.sin(o.yaw), c = Math.cos(o.yaw);
      let lf = dx * s + dz * c, lr = -dx * c + dz * s;
      const hw = def.size.w / 2 + r, hl = def.size.l / 2 + r;
      if (Math.abs(lr) >= hw || Math.abs(lf) >= hl) continue;
      if (hw - Math.abs(lr) < hl - Math.abs(lf)) lr = Math.sign(lr || 1) * hw; else lf = Math.sign(lf || 1) * hl;
      p.x = o.position.x + lf * s - lr * c;
      p.z = o.position.z + lf * c + lr * s;
      ped.bumpT += 0.05;
    }
  }

  /** Can an angry driver get back into their car? */
  canReturnTo(ped, v) {
    const g = this.game;
    if (!v || v.removed || v.destroyed || v.driver || v.ai || v.alive === false) return false;
    if (g.vehicles && g.vehicles.playerVehicle === v) return false;
    if (!g.traffic || typeof g.traffic.adoptVehicle !== 'function') return false;
    const dx = v.position.x - ped.position.x, dz = v.position.z - ped.position.z;
    return dx * dx + dz * dz < 40 * 40;
  }

  /** The ped gets back into their car and drives off (handed to Traffic). */
  reboard(ped, v) {
    const g = this.game;
    const d = g.traffic && g.traffic.adoptVehicle ? g.traffic.adoptVehicle(v, { look: ped.look }) : null;
    if (d) {
      g.audio?.play?.('car_door', { position: v.position, volume: 0.7 });
      this.remove(ped);
    } else {
      ped.homeVehicle = null;
      ped.calmDown();
    }
  }

  getBlips(out) {
    const pl = this.game.player;
    for (const p of this.list) {
      if (!p.alive || p.removed) continue;
      if (p.state === 'shoot' && p.target === pl) out.push({ x: p.position.x, z: p.position.z, color: '#ff3030', shape: 'dot', size: 5 });
      else if (p.state === 'fight' && p.target === pl) out.push({ x: p.position.x, z: p.position.z, color: '#ff9a3c', shape: 'dot', size: 4 });
    }
  }

  // ============================================================================================ debug

  _installDebug() {
    const g = this.game, d = g.debug, self = this;
    if (!d) return;
    /** Spawn n pedestrians around the player (6-25 m, on sidewalks when possible). Returns how many spawned. */
    d.spawnPeds = (n = 10, opts = {}) => {
      const p = g.player.position;
      let k = 0;
      for (let i = 0; i < n * 8 && k < n; i++) {
        const a = Math.random() * Math.PI * 2, r = rand(6, 25);
        const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
        const y = self.walkable(x, z, g.generator.plan.isSidewalk(x, z));
        if (y < 0 || self._crowded(x, z, 1)) continue;
        if (self._add(new THREE.Vector3(x, y, z), { mode: 'walk', persistent: false, ...opts })) k++;
      }
      return k;
    };
    /** Spawn n armed gang members around the player. */
    d.spawnGang = (n = 4) => d.spawnPeds(n, { team: 'gang', weapon: 'pistol' });
    /** Make gang members near the player hostile. */
    d.gangAggro = (radius = 60) => { self.gangAggro(g.player.position, radius, g.player); return self.pedStats().hostile; };
    /** Panic everyone near a point (defaults to the player). */
    d.panicPeds = (radius = 30) => { self.panicAt(g.player.position, radius, null, null, 0.4); return self.pedStats().states; };
    d.pedInfo = () => self.list.map((p) => ({
      state: p.state, mode: p.mode, team: p.team, x: +p.position.x.toFixed(1), y: +p.position.y.toFixed(1), z: +p.position.z.toFixed(1),
      hp: Math.round(p.health), speed: +p.hspeed.toFixed(2), edge: p.edge ? p.edge.kind : null,
    }));
    /** Traffic + pedestrian statistics. */
    d.npcStats = () => ({ peds: self.pedStats(), traffic: g.traffic && g.traffic.stats ? g.traffic.stats() : null });
  }
}

const PISTOL_MAT = new THREE.MeshLambertMaterial({ color: 0x2b2b30 });

/** Distance from a point to the middle of an edge (cheap spawn bias). */
function edgeDist(e, p) {
  return Math.hypot((e.ax + e.bx) / 2 - p.x, (e.az + e.bz) / 2 - p.z);
}

function mergeBoxes(parts) {
  let n = 0;
  for (const p of parts) n += p.toNonIndexed().attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const q = p.toNonIndexed();
    pos.set(q.attributes.position.array, o * 3);
    nor.set(q.attributes.normal.array, o * 3);
    o += q.attributes.position.count;
    q.dispose(); p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
