// Combat system (COMBAT agent, ARCHITECTURE.md §Combat): player weapons, AI shots, melee, explosions that carve the
// voxel world, chain-reacting primed TNT, grenades, rockets, drive-bys and the voxel weapon models.
//
// Public API (contract):
//   updatePlayerWeapon(dt, item, {firing, firingPressed, aiming, reloadPressed})   Player, on foot, weapon items only
//   fire(shooter, origin, dir, weaponId) -> {entity|block hit record} | null       AI shots (cops, gang, heli sniper)
//   melee(attacker, origin, dir, damage, range) -> entity | null                     punches / bats
//   explode(position, {radius, power, damage, source})                              any explosion
//   throwGrenade(thrower, origin, dir, power)                                       bouncing grenade with a fuse
//   getWeaponViewModel(id) -> THREE.Object3D | null                                 voxel weapon / tool models
// Extras: primeTNT(x, y, z, source, {fuse}), launchRocket(shooter, origin, dir, opts), reloading / isReloading(),
//   reloadProgress(), getMuzzleOffset(id), handlesGrenadeKey (Combat owns the G key), stats.
// Debug: game.debug.giveWeapons(), explode(x,y,z,r), primeTNT(x,y,z), aimAt(x,y,z), spawnDummy(x,y,z), combatStats().
import * as THREE from 'three';
import { WEAPONS, SHOP_WEAPONS } from '../data/weapons.js';
import { hasLineOfSight } from '../core/physics.js';
import { entityBox } from '../core/entities.js';
import { B } from '../world/blocks.js';
import { getWeaponModel, muzzleOffset } from './weaponModels.js';
import { Ballistics, spreadDir, falloff, isHumanoid, isVehicle, makeTraceRecord, closestPointOnBox } from './ballistics.js';
import { Projectiles } from './projectiles.js';
import { TNTManager } from './tnt.js';
import { doExplode, EXPLODE_MAX_DEPTH } from './explosions.js';
import { PlayerWeapon } from './playerWeapon.js';
import { TargetDummy } from './dummy.js';
import { Casings } from './casings.js';

const _box = new THREE.Box3();
const _c = new THREE.Vector3();
const _to = new THREE.Vector3();
const _mid = new THREE.Vector3();

/** Melee can hit living things and vehicles (not corpses, not lit TNT). */
const meleeFilter = (e) => e.kind !== 'tnt' && (e.alive !== false || isVehicle(e));

export class Combat {
  constructor(game) {
    this.game = game;
    /** Tells Player's interaction code that Combat handles the grenade key (G). */
    this.handlesGrenadeKey = true;
    this.ballistics = new Ballistics(this);
    this.projectiles = new Projectiles(this);
    this.tnt = new TNTManager(this);
    this.pw = new PlayerWeapon(this);
    this.casings = new Casings(this);
    this.dummies = [];
    this._sounds = [];
    this._explodeDepth = 0;
    this._deferred = [];
    this._errored = false;
    this._aiRec = makeTraceRecord();
    this._aiDir = new THREE.Vector3();
    this._aiPd = new THREE.Vector3();
    this._mDir = new THREE.Vector3();
    this._mq = [];
    this._driveBy = false;
    /** Counters (debug / tests). */
    this.stats = { playerShots: 0, aiShots: 0, explosions: 0, meleeHits: 0, tntPrimed: 0 };
  }

  init() {
    const g = this.game;
    const ev = g.events;
    ev.on('playerRespawned', () => { this.pw._cancelReload(); this.pw.pendingSwing = null; });
    ev.on('playerDied', () => { this.pw._cancelReload(); this.pw.pendingSwing = null; });
    ev.on('weaponFired', (e) => { if (e && e.byPlayer) this.stats.playerShots++; });
    // compile every combat material up front (title screen) so the first shot / blast never hitches
    ev.on('ready', () => { try { this._prewarm(); } catch (e) { console.warn('[combat] prewarm failed', e); } });
    this._installDebug();
  }

  /** Pre-compile shader programs for weapon models, lit TNT, casings, rocket exhaust and the grenade arc. */
  _prewarm() {
    const g = this.game, r = g.renderer;
    if (!r || typeof r.compile !== 'function' || !g.scene || !g.camera) return;
    const grp = new THREE.Group();
    const m = getWeaponModel('rifle');
    if (m) grp.add(m);
    this.tnt._ensureAssets();
    if (this.tnt._geo) {
      grp.add(new THREE.Mesh(this.tnt._geo, this.tnt._mat));
      grp.add(new THREE.Mesh(this.tnt._geo, this.tnt._matFlash));
    }
    this.projectiles._ensureFlame();
    grp.add(new THREE.Mesh(this.projectiles._flameGeo, this.projectiles._flameMat));
    r.compile(grp, g.camera, g.scene);
    this.casings._ensure();
    if (this.casings.mesh) r.compile(this.casings.mesh, g.camera, g.scene);
    const arc = this.pw.arc.ensure();
    if (arc) r.compile(arc.root, g.camera, g.scene);
  }

  // ======================================================================================= public API

  /** True while the player's selected weapon is reloading (HUD shows RELOADING). */
  get reloading() { return this.pw.isReloading(); }
  isReloading() { return this.pw.isReloading(); }
  /** 0..1 reload progress of the selected weapon, or null. */
  reloadProgress() { return this.pw.reloadProgress(); }

  /**
   * Player weapon logic, called by Player every frame on foot while a weapon item is selected.
   * inp = {firing, firingPressed, aiming, reloadPressed}.
   */
  updatePlayerWeapon(dt, item, inp = {}) {
    if (!item || item.kind !== 'weapon' || !WEAPONS[item.id]) return;
    const p = this.game.player;
    if (!p || p.alive === false || p.inVehicle) return;
    try {
      this.pw.update(dt, item, inp, {});
    } catch (e) {
      if (!this._errored) { this._errored = true; console.error('[combat] updatePlayerWeapon', e); }
    }
  }

  /**
   * Generic shot for AI (cops, gang members, the police heli sniper). Applies the weapon's spread, pellets, damage
   * (AI headshots: x aiHeadshot on NPCs, at most x1.25 on the player), glass / TNT / impact handling, muzzle flash,
   * tracer, positional sound and the gunfire event.
   * RPG ids launch a rocket, grenade ids throw a grenade (both return null). Returns the main hit:
   * {entity, point, distance} | {block: {x,y,z,id}, point, normal, distance} | null.
   */
  fire(shooter, origin, dir, weaponId = 'pistol') {
    const g = this.game;
    if (!origin || !dir || !Number.isFinite(origin.x) || !Number.isFinite(dir.x)) return null;
    const def = WEAPONS[weaponId] || WEAPONS.pistol;
    const d = this._aiDir.copy(dir);
    if (d.lengthSq() < 1e-8) return null;
    d.normalize();
    this.stats.aiShots++;
    const ignore = this._ignoreFor(shooter);
    if (def.kind === 'projectile') {
      const sd = spreadDir(d, def.spread || 0.004, this._aiPd, 1.5);
      this.launchRocket(shooter, origin, sd, { weapon: def.id, ignore: Array.isArray(ignore) ? ignore : [ignore] });
      return null;
    }
    if (def.kind === 'throw') { this.throwGrenade(shooter, origin, d, def.throwSpeed); return null; }
    if (def.kind === 'melee') {
      const e = this.melee(shooter, origin, d, def.damage, def.range, { weapon: def.id, knockback: def.knockback });
      return e ? { entity: e, point: e.position.clone(), distance: e.position.distanceTo(origin) } : null;
    }
    const pellets = def.pellets || 1;
    let best = null;
    let whizEnd = null;
    const hits = [];
    for (let k = 0; k < pellets; k++) {
      const pd = spreadDir(d, def.spread || 0.01, this._aiPd, pellets > 1 ? 1 : 1.4);
      const rec = this.ballistics.trace(origin, pd, def.range || 120, ignore, shooter, this._aiRec);
      if (k === 0) whizEnd = rec.point.clone();
      if (rec.kind === 'entity' && rec.entity) {
        const e = rec.entity;
        let dmg = (def.damage || 10) * falloff(def, rec.distance);
        let head = false;
        if (isHumanoid(e) && e.alive !== false && Number.isFinite(e.height)) {
          head = rec.point.y > e.position.y + e.height * 0.83;
          // NPC headshots on the player only sting a little more (no frustrating one-shots from a sniper cop); NPC vs NPC
          // keeps the AI multiplier (the big player headshot multipliers are for the player's guns only)
          if (head) dmg *= e === g.player ? Math.min(1.25, def.headshot ?? 2) : (def.aiHeadshot ?? def.headshot ?? 2);
        }
        let h = hits.find((x) => x.entity === e);
        if (!h) { h = { entity: e, damage: 0, point: rec.point.clone(), dir: pd.clone(), headshot: false, pellets: 0 }; hits.push(h); }
        h.damage += dmg; h.headshot = h.headshot || head; h.pellets += def.pellets ? 1 : 0;
        if (!best || !best.entity) best = { entity: e, point: rec.point.clone(), distance: rec.distance };
      } else if (rec.kind !== 'none' && !best) {
        best = { block: rec.block, point: rec.point.clone(), normal: rec.normal.clone(), distance: rec.distance };
      }
      if (pellets === 1 || k < 3) { try { g.fx?.tracer?.(origin, rec.point, def.tracer); } catch (e) { /* fx */ } }
    }
    for (const h of hits) this.ballistics.applyEntityHit(h, shooter, def);
    this._whiz(origin, whizEnd, best, shooter);
    try { g.fx?.muzzleFlash?.(origin, d); } catch (e) { /* fx */ }
    _to.set(-d.z, 0, d.x);
    if (_to.lengthSq() > 1e-6) { _to.normalize(); this.casings.eject(_mid.copy(origin).addScaledVector(d, -0.2), _to, d, def.id, shooter && shooter.velocity, def.id === 'shotgun' ? 0.3 : 0); }
    g.audio?.play?.(def.sound || 'gunshot_pistol', { position: origin, volume: 0.95, pitch: 0.95 + Math.random() * 0.1 });
    g.events.emit('gunfire', { shooter: shooter || null, position: origin.clone(), weapon: def.id });
    return best;
  }

  /**
   * Melee attack: a ray plus a small cone in front of `origin` (unit `dir`), within `range` metres.
   * Damage type 'melee', knockback, punch sound. opts: {weapon, knockback}. Returns the entity hit or null.
   */
  melee(attacker, origin, dir, damage = 12, range = 2.4, opts = {}) {
    const g = this.game, ents = g.entities;
    if (!origin || !dir || !ents) return null;
    const d = this._mDir.copy(dir);
    if (d.lengthSq() < 1e-8) return null;
    d.normalize();
    const ignore = this._ignoreFor(attacker);
    const ignored = (e) => e === ignore || (Array.isArray(ignore) && ignore.includes(e));
    let target = null;
    let point = null;
    let rh = null;
    try { rh = ents.raycast(origin, d, range, ignore, meleeFilter); } catch (e) { rh = null; }
    if (rh) { target = rh.entity; point = rh.point; }
    else {
      // forgiving cone: anything roughly in front within reach (and not behind a wall)
      _mid.copy(origin).addScaledVector(d, range * 0.5);
      const cand = ents.query(_mid, range + 1.5, null, this._mq);
      let bestScore = Infinity;
      for (const e of cand) {
        if (ignored(e) || e.hidden || !meleeFilter(e)) continue;
        try { entityBox(e, _box); } catch (err) { continue; }
        closestPointOnBox(_box, origin, _c);
        _to.subVectors(_c, origin);
        const dist = _to.length();
        if (dist > range) continue;
        // aim at the body centre for the angle test (closest point can be under the feet when standing above)
        _to.set((_box.min.x + _box.max.x) * 0.5 - origin.x, Math.min(_box.max.y - 0.2, Math.max(_box.min.y + 0.2, origin.y)) - origin.y,
          (_box.min.z + _box.max.z) * 0.5 - origin.z);
        const len = _to.length() || 1;
        const cos = (_to.x * d.x + _to.y * d.y + _to.z * d.z) / len;
        const minCos = dist < 1.0 ? 0.45 : 0.72;
        if (cos < minCos) continue;
        if (g.world) {
          let los = true;
          try { los = hasLineOfSight(g.world, origin, _c); } catch (err) { los = true; }
          if (!los) continue;
        }
        const score = dist * (2 - cos);
        if (score < bestScore) { bestScore = score; target = e; point = _c.clone(); }
      }
    }
    if (!target) {
      if (attacker !== g.player) g.audio?.play?.('melee_swing', { position: origin, volume: 0.45 });
      return null;
    }
    const heavy = damage >= 30;
    const info = { type: 'melee', source: attacker || null, point: point.clone(), dir: d.clone(), weapon: opts.weapon || (heavy ? 'bat' : 'fist') };
    try { target.damage(damage, info); } catch (e) { console.warn('[combat] melee damage() threw', e); }
    this.stats.meleeHits++;
    const kb = Number.isFinite(opts.knockback) ? opts.knockback : heavy ? 5.6 : 2.2;
    if (typeof target.knockback === 'function') {
      const k = isVehicle(target) ? kb * 0.25 : kb;
      try { target.knockback(new THREE.Vector3(d.x * k, isVehicle(target) ? 0 : 1 + k * 0.18, d.z * k)); } catch (e) { /* ignore */ }
    }
    if (isVehicle(target)) {
      try { g.fx?.sparks?.(point, _to.copy(d).negate()); } catch (e) { /* fx */ }
      g.audio?.play?.('block_hit', { position: point, volume: 0.9, pitch: 0.55 });
    } else {
      g.audio?.play?.('punch', { position: point, volume: heavy ? 1 : 0.8, pitch: heavy ? 0.75 + Math.random() * 0.1 : 0.95 + Math.random() * 0.15 });
      if (heavy && target.kind !== 'ped') { try { g.fx?.blood?.(point, d); } catch (e) { /* fx */ } }
    }
    if (attacker && attacker === g.player) { try { g.cameraRig?.shake?.(heavy ? 0.12 : 0.05); } catch (e) { /* ignore */ } }
    return target;
  }

  /**
   * Explosion: world.explode (removed TNT becomes primed TNT -> chain reactions), damage with linear falloff and
   * knockback (vehicles x1.5 + upward push; the player too), FX, sound, camera shake, 'explosion' event and a crime
   * when the player caused it. opts: {radius = 4, power = 3, damage = 100, source = null}.
   */
  explode(position, opts = {}) {
    if (!position) return { removed: [], hit: [] };
    if (this._explodeDepth >= EXPLODE_MAX_DEPTH) {
      this._deferred.push({ pos: new THREE.Vector3().copy(position), opts: { ...opts } });
      return { removed: [], hit: [] };
    }
    this.stats.explosions++;
    return doExplode(this, position, opts || {});
  }

  /** Throw a bouncing grenade (fuse 2.5 s, radius 4.5, power 3). power = launch speed (default 18 m/s). */
  throwGrenade(thrower, origin, dir, power) {
    return this.projectiles.throwGrenade(thrower, origin, dir, power);
  }

  /** Launch a rocket (speed 60, smoke trail, explodes on impact or at max range). opts: {ignore, weapon}. */
  launchRocket(shooter, origin, dir, opts = {}) {
    return this.projectiles.launchRocket(shooter, origin, dir, opts);
  }

  /**
   * Prime the TNT block at (x,y,z): removes it and spawns a lit, flashing TNT entity that explodes after `fuse`
   * seconds (default 3) with source = whoever lit it. Returns the primed entity or null (no TNT there).
   */
  primeTNT(x, y, z, source = null, opts = {}) {
    const t = this.tnt.prime(x, y, z, source, { fuse: opts.fuse, removeBlock: true });
    if (!t) return null;
    this.stats.tntPrimed++;
    const g = this.game;
    g.events.emit('blockBroken', { x: x | 0, y: y | 0, z: z | 0, id: B.TNT, byPlayer: !!source && source === g.player, cause: opts.cause || 'primed' });
    return t;
  }

  /** Voxel weapon / tool model pointing +Z at real scale (grip at the origin). 'fist' / unknown -> null. */
  getWeaponViewModel(id) {
    return getWeaponModel(id);
  }

  /** Barrel-end offset of a weapon model (model space, metres). */
  getMuzzleOffset(id, out) {
    return muzzleOffset(id, out || new THREE.Vector3());
  }

  /**
   * Extra muzzle light for the player's shots. fx.muzzleFlash already flashes a pooled light for every shot, so this
   * only adds a second, wider pulse for the heavy guns (flash scale > 1.2: shotgun, sniper, RPG). No dedicated
   * PointLight lives in the scene any more (one fewer light compiled into every lit shader).
   */
  flashLight(pos, dir, k = 1) {
    if (!pos || !(k > 1.2)) return;
    try { this.game.fx?.flash?.(pos, { color: 0xffc27a, intensity: 45 * k, distance: 12, duration: 0.06, priority: 1 }); } catch (e) { /* fx */ }
    void dir;
  }

  // ======================================================================================= frame

  update(dt) {
    const g = this.game;
    // explosions deferred by a very deep chain
    if (this._deferred.length) {
      const batch = this._deferred.splice(0, 4);
      for (const d of batch) this.explode(d.pos, d.opts);
    }
    this.ballistics.update(dt);
    if (this._sounds.length) this._updateSounds(dt);
    this.pw.tick(dt);
    this.casings.update(dt);
    this.projectiles.update(dt);
    this.tnt.update(dt);
    for (let i = this.dummies.length - 1; i >= 0; i--) this.dummies[i].update(dt);
    this._updateGrenadeKey();
    this._updateDriveBy(dt);
  }

  /** Minimap: live explosives near the player (lit TNT, grenades) as small flashing red dots. */
  getBlips(out) {
    const p = this.game.player;
    if (!p || !p.position) return;
    let n = 0;
    const add = (pos) => {
      if (n >= 12) return;
      const dx = pos.x - p.position.x, dz = pos.z - p.position.z;
      if (dx * dx + dz * dz > 90 * 90) return;
      out.push({ x: pos.x, z: pos.z, color: '#ff3b30', shape: 'dot', size: 4, flash: true });
      n++;
    };
    for (const t of this.tnt.list) add(t.position);
    for (const gr of this.projectiles.grenades) add(gr.pos);
  }

  /** Play a (non-positional) sound after `delay` seconds of game time. */
  queueSound(name, delay, opts = {}) {
    if (this._sounds.length < 12) this._sounds.push({ name, t: Math.max(0, delay), opts });
  }

  _updateSounds(dt) {
    for (let i = this._sounds.length - 1; i >= 0; i--) {
      const s = this._sounds[i];
      s.t -= dt;
      if (s.t <= 0) { this._sounds.splice(i, 1); this.game.audio?.play?.(s.name, s.opts); }
    }
  }

  /** G: quick-throw a grenade when on foot (any selected item). */
  _updateGrenadeKey() {
    const g = this.game, p = g.player, input = g.input;
    if (!p || !input || p.alive === false || p.frozen || p.inVehicle) return;
    if (!input.pressed('grenade')) return;
    if (p.inWater && !p.onGround) return;
    const sel = g.inventory?.getSelected?.();
    const item = sel && sel.kind === 'weapon' && sel.id === 'grenade' ? sel : (g.inventory?.getWeapon?.('grenade') || this._findWeapon('grenade'));
    this.pw.throwFromPlayer(item);
  }

  _findWeapon(id) {
    const slots = this.game.inventory?.slots;
    if (!Array.isArray(slots)) return null;
    for (const it of slots) if (it && it.kind === 'weapon' && it.id === id) return it;
    return null;
  }

  /** Shooting pistols / SMGs out of the window of a car or bike. */
  _updateDriveBy(dt) {
    const g = this.game, p = g.player, input = g.input;
    const v = p && p.inVehicle;
    const was = this._driveBy;
    this._driveBy = false;
    if (!v || !input || p.alive === false || p.frozen) return;
    const kind = (v.def && v.def.kind) || (v.kind === 'heli' ? 'heli' : 'car');
    if (kind === 'heli' || v.isHeli) return;
    const item = g.inventory?.getSelected?.();
    const def = item && item.kind === 'weapon' ? WEAPONS[item.id] : null;
    if (!def || !def.driveBy) return;
    const firing = input.down('attack');
    const aiming = input.down('aim');
    this._driveBy = true;
    // let the HUD show the crosshair while shooting from the car (Player resets this every frame)
    if (firing || aiming) p.aiming = true;
    try {
      this.pw.update(dt, item, {
        firing, firingPressed: input.pressed('attack'), aiming, reloadPressed: input.pressed('reload'),
      }, { driveBy: true, vehicle: v });
    } catch (e) {
      if (!this._errored) { this._errored = true; console.error('[combat] drive-by', e); }
    }
    if (!was && this._driveBy && firing) p.noteAction?.();
  }

  /** Near miss: a bullet that passes close to the player's head snaps past (sound + a tiny flinch). */
  _whiz(origin, end, best, shooter) {
    const g = this.game, p = g.player;
    if (!p || p.alive === false || p.inVehicle || shooter === p || (best && best.entity === p)) return;
    if (!end) return;
    const head = _c.set(p.position.x, p.position.y + 1.6, p.position.z);
    _to.subVectors(end, origin);
    const len = _to.length();
    if (len < 1e-3) return;
    _to.divideScalar(len);
    const t = Math.max(0, Math.min(len, (head.x - origin.x) * _to.x + (head.y - origin.y) * _to.y + (head.z - origin.z) * _to.z));
    _mid.copy(origin).addScaledVector(_to, t);
    const d = _mid.distanceTo(head);
    if (d > 1.8 || t < 2) return;
    g.audio?.play?.('bullet_impact', { position: _mid, volume: 0.5 * (1 - d / 1.8) + 0.15, pitch: 2.4 + Math.random() * 0.4 });
    try { g.cameraRig?.shake?.(0.05); } catch (e) { /* ignore */ }
  }

  /** Entities a shot from `shooter` must ignore: itself and the vehicle it sits in. */
  _ignoreFor(shooter) {
    if (!shooter) return null;
    const veh = shooter.inVehicle || shooter.vehicle || null;
    return veh && typeof veh === 'object' ? [shooter, veh] : shooter;
  }

  // ======================================================================================= debug

  _installDebug() {
    const g = this.game, d = g.debug;
    if (!d) return;
    const self = this;
    /** Give every shop weapon with plenty of ammo. */
    d.giveWeapons = (mags = 6) => {
      const inv = g.inventory;
      if (!inv || typeof inv.addWeapon !== 'function') return false;
      for (const id of SHOP_WEAPONS) {
        const def = WEAPONS[id];
        const ammo = id === 'grenade' || id === 'rpg' ? 10 : def.mag > 0 ? def.mag * mags : 0;
        inv.addWeapon(id, ammo);
      }
      return inv.slots ? inv.slots.filter((s) => s && s.kind === 'weapon').map((s) => `${s.id}:${s.mag}/${s.reserve}`) : true;
    };
    /** Explosion at (x,y,z). */
    d.explode = (x, y, z, r = 5, power = 4, damage = 150) => {
      const res = self.explode(new THREE.Vector3(x, y, z), { radius: r, power, damage, source: null });
      return { removed: res.removed.length, hit: res.hit.length };
    };
    d.primeTNT = (x, y, z, fuse) => !!self.primeTNT(x, y, z, g.player, { fuse });
    /** Point the camera rig at a world point (repeat over a few frames: the third-person camera orbits). */
    d.aimAt = (x, y, z) => {
      const rig = g.cameraRig, cam = g.camera;
      if (!rig || !cam) return null;
      // from the player's eye (the orbiting third-person camera moves when the pitch changes); camera in a car
      const p = g.player;
      let o;
      if (p && !p.inVehicle && !rig.firstPerson && rig._pivot && Number.isFinite(rig._off)) {
        // third person: the crosshair ray starts at the shoulder point (pivot + right * offset): solve iteratively
        let yaw = rig.yaw;
        o = new THREE.Vector3();
        for (let i = 0; i < 4; i++) {
          o.copy(rig._pivot).add(new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(rig._off));
          yaw = Math.atan2(x - o.x, z - o.z);
        }
      } else {
        o = p && !p.inVehicle && p.getEyePosition ? p.getEyePosition(new THREE.Vector3()) : new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      }
      const dx = x - o.x, dy = y - o.y, dz = z - o.z;
      rig.yaw = Math.atan2(dx, dz);
      rig.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      if (g.player) g.player.yaw = rig.yaw;
      return { yaw: +rig.yaw.toFixed(3), pitch: +rig.pitch.toFixed(3) };
    };
    /** Shooting-range dummy that records hits. */
    d.spawnDummy = (x, y, z, opts = {}) => {
      if (y === undefined || y === null) y = g.world?.findGround ? g.world.findGround(x, z) : 30;
      const dm = new TargetDummy(g, x, y, z, opts);
      g.entities.add(dm);
      self.dummies.push(dm);
      return dm.id;
    };
    d.clearDummies = () => { for (const dm of self.dummies) dm.dispose(); self.dummies.length = 0; };
    d.dummyHits = (id) => {
      const dm = id ? self.dummies.find((x) => x.id === id) : self.dummies[self.dummies.length - 1];
      return dm ? { health: dm.health, alive: dm.alive, deaths: dm.deaths, hits: dm.hits.slice(-30), pos: dm.position.toArray().map((v) => +v.toFixed(2)) } : null;
    };
    d.combatStats = () => ({
      ...self.stats, primed: self.tnt.count, grenades: self.projectiles.grenades.length, rockets: self.projectiles.rockets.length,
      reloading: self.reloading, deferred: self._deferred.length,
    });
  }
}
