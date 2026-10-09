// Player weapon handling (COMBAT): fire rate (auto / semi with click buffering), magazine + reserve, reloads
// (manual, automatic, shell-by-shell for the pump shotgun), spread (aim / crouch / move / air / bloom), recoil,
// muzzle placement (third person hand, first person view model, car window for drive-bys), bat swings with a
// mid-swing hit, grenade throws with a trajectory preview arc, and the RPG warhead visibility.
import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { voxelRaycast } from '../core/physics.js';
import { spreadDir, falloff, isHumanoid, makeTraceRecord, GLASS_IDS } from './ballistics.js';
import { muzzleOffset } from './weaponModels.js';
import { GRENADE } from './projectiles.js';
import { GrenadeArc } from './grenadeArc.js';

// humanoid rig (see entities/humanoid.js): shoulder pivot height/side, shoulder -> hand distance
const SHOULDER_Y = 1.2375, SHOULDER_X = 0.3375, ARM_LEN = 0.53;
/** First-person weapon length (matches the view model's normalisation). */
const FP_LEN = { pistol: 0.3, smg: 0.46, shotgun: 0.72, rifle: 0.72, sniper: 0.82, rpg: 0.9, grenade: 0.12, bat: 0.78 };
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SEMI_BUFFER = 0.16;

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _mo = new THREE.Vector3();
const _hm = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

export class PlayerWeapon {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this.nextFire = 0;
    this.reloadT = 0;
    this.reloadTotal = 0;
    this.reloadItem = null;
    this.bloom = 0;
    this.buffer = 0;
    this.emptyT = 0;
    this.autoReloadT = 0;
    this.lastItem = null;
    this.lastFrame = -10;
    this.drawUntil = 0;
    this.drawUntilMs = 0;
    this.pendingSwing = null;
    this.grenadeNext = 0;
    this.noAmmoNoteT = 0;
    this._ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
    this._target = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._pd = new THREE.Vector3();
    this._rec = makeTraceRecord();
    this._hits = [];
    this._hitPool = [];
    this._gs = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, inWater: false };
    this.arc = new GrenadeArc(this.game);
    this._warheads = new WeakMap();
  }

  // ------------------------------------------------------------------------------------------- public

  /** True while the selected weapon is reloading. */
  isReloading() {
    const it = this.game.inventory?.getSelected?.();
    return this.reloadT > 0 && !!this.reloadItem && this.reloadItem === it;
  }

  /** 0..1 progress of the current reload (null when not reloading). */
  reloadProgress() {
    if (!this.isReloading() || !(this.reloadTotal > 0)) return null;
    return 1 - this.reloadT / this.reloadTotal;
  }

  /** Current spread cone (radians) for the selected weapon (for UI / tests). */
  currentSpread(aiming = false) {
    const it = this.game.inventory?.getSelected?.();
    const def = it && it.kind === 'weapon' ? WEAPONS[it.id] : null;
    if (!def || !(def.kind === 'hitscan' || def.kind === 'projectile')) return 0;
    return this._spread(def, aiming, {});
  }

  /**
   * Per-frame weapon logic. inp = {firing, firingPressed, aiming, reloadPressed};
   * ctx = {driveBy: bool, vehicle} (drive-by from a car window).
   */
  update(dt, item, inp, ctx = {}) {
    const g = this.game;
    const def = item && WEAPONS[item.id];
    if (!def) return;
    inp = inp || {};
    if (item !== this.lastItem || g.frame - this.lastFrame > 2) this._equip(item, def);
    this.lastItem = item;
    this.lastFrame = g.frame;
    if (def.kind === 'melee') this._melee(item, def, inp);
    else if (def.kind === 'throw') this._grenadeWeapon(item, def, inp, ctx);
    else this._gun(dt, item, def, inp, ctx);
  }

  /** Timers that must run every frame (called by Combat.update). */
  tick(dt) {
    const g = this.game;
    this.bloom *= Math.exp(-dt * 5);
    this.buffer -= dt;
    this.emptyT -= dt;
    this.noAmmoNoteT -= dt;
    const sel = g.inventory?.getSelected?.() || null;
    // switching away cancels a reload
    if (this.reloadItem && this.reloadItem !== sel) this._cancelReload();
    if (this.autoReloadT > 0) {
      this.autoReloadT -= dt;
      if (this.autoReloadT <= 0 && sel && sel === this.lastItem && g.frame - this.lastFrame <= 2) {
        const def = WEAPONS[sel.id];
        if (def) this.startReload(sel, def);
      }
    }
    if (this.pendingSwing) {
      this.pendingSwing.t -= dt;
      if (this.pendingSwing.t <= 0) { const s = this.pendingSwing; this.pendingSwing = null; this._resolveSwing(s); }
    }
    this.arc.tick();
    if (sel && sel.kind === 'weapon' && sel.id === 'rpg') this._syncWarhead(sel);
  }

  /** Start reloading `item` (no-op when full / no reserve). Returns true if a reload started. */
  startReload(item, def) {
    if (!item || !def || !(def.mag > 0)) return false;
    if (this.reloadItem === item && this.reloadT > 0) return false;
    if ((item.mag | 0) >= def.mag || (item.reserve | 0) <= 0) return false;
    const g = this.game;
    this.autoReloadT = 0;
    this.reloadItem = item;
    this.reloadTotal = def.shellReload ? def.shellReload * (def.mag - item.mag) + 0.25 : (def.reload || 1.5);
    this.reloadT = def.shellReload ? def.shellReload + 0.25 : this.reloadTotal;
    this._reloadElapsed = 0;
    g.audio?.play?.('reload', { position: this._eye(), volume: 0.85, pitch: def.id === 'rpg' ? 0.8 : def.id === 'pistol' ? 1.15 : 1 });
    g.events.emit('weaponReload', { weapon: def.id, byPlayer: true, duration: this.reloadTotal });
    return true;
  }

  // ------------------------------------------------------------------------------------------- internals

  _equip(item, def) {
    const g = this.game;
    this._cancelReload();
    this.bloom = 0;
    this.buffer = 0;
    this.pendingSwing = null;
    const draw = def.kind === 'melee' ? 0.1 : def.kind === 'throw' ? 0.2 : def.id === 'pistol' ? 0.15 : 0.22;
    // a fresh draw: the previous weapon's cooldown does not carry over. Measured in real time so a slow frame
    // rate (dt is clamped) cannot stretch the draw.
    this.nextFire = g.time;
    this.drawUntil = g.realTime + draw;
    this.drawUntilMs = nowMs() + draw * 1000;
    // an empty gun with spare ammo reloads as soon as it is drawn
    if (def.mag > 0 && (def.kind === 'hitscan' || def.kind === 'projectile') && (item.mag | 0) <= 0 && (item.reserve | 0) > 0) this.autoReloadT = draw + 0.05;
  }

  /** Seconds of weapon draw left: done when either the simulated or the wall-clock draw time has passed. */
  _drawLeft() {
    const a = this.drawUntil - this.game.realTime;
    const b = (this.drawUntilMs - nowMs()) / 1000;
    return Math.max(0, Math.min(a, b));
  }

  _cancelReload() {
    this.reloadT = 0;
    this.reloadItem = null;
    this.autoReloadT = 0;
  }

  _notifyInventory() {
    const g = this.game, inv = g.inventory;
    if (inv && typeof inv.notifyChanged === 'function') inv.notifyChanged();
    else g.events.emit('inventoryChanged', {});
  }

  _eye(out = _t2) {
    const p = this.game.player;
    if (!p) return out.set(0, 0, 0);
    if (typeof p.getEyePosition === 'function') return p.getEyePosition(out);
    return out.set(p.position.x, p.position.y + 1.6, p.position.z);
  }

  /** Aim ray from the camera rig (fallback: player's yaw). */
  _aimRay() {
    const g = this.game, rig = g.cameraRig, r = this._ray;
    if (rig && typeof rig.getAimRay === 'function') {
      try { rig.getAimRay(r); if (Number.isFinite(r.dir.x) && r.dir.lengthSq() > 0.5) return r; } catch (e) { /* fall through */ }
    }
    const p = g.player;
    this._eye(r.origin);
    const yaw = p ? p.yaw || 0 : 0;
    r.dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    return r;
  }

  _reloadTick(dt, item, def) {
    if (!(this.reloadT > 0) || this.reloadItem !== item) return;
    const g = this.game;
    this.reloadT -= dt;
    if (this.reloadT > 0) return;
    if (def.shellReload) {
      // pump shotgun: one shell at a time, can be interrupted by firing
      if ((item.reserve | 0) > 0 && (item.mag | 0) < def.mag) {
        item.mag++; item.reserve--;
        this._notifyInventory();
        g.audio?.play?.('reload', { position: this._eye(), volume: 0.55, pitch: 1.35 + Math.random() * 0.1 });
      }
      if ((item.mag | 0) < def.mag && (item.reserve | 0) > 0) { this.reloadT = def.shellReload; return; }
      this._cancelReload();
      return;
    }
    const n = Math.min(def.mag - (item.mag | 0), item.reserve | 0);
    if (n > 0) { item.mag = (item.mag | 0) + n; item.reserve = (item.reserve | 0) - n; }
    this._cancelReload();
    this._notifyInventory();
    g.audio?.play?.('empty_click', { position: this._eye(), volume: 0.35, pitch: 0.7 });
  }

  _gun(dt, item, def, inp, ctx) {
    const g = this.game;
    const now = g.time;
    if (inp.reloadPressed) this.startReload(item, def);
    this._reloadTick(dt, item, def);
    // a click during the draw / cooldown is remembered until the gun is ready (max 0.5 s)
    const drawLeft = this._drawLeft();
    if (inp.firingPressed) this.buffer = Math.min(0.5, Math.max(SEMI_BUFFER, this.nextFire - now + 0.05, drawLeft + 0.05));
    const wants = def.auto ? !!inp.firing : this.buffer > 0;
    if (!wants || drawLeft > 0) return;
    if (this.reloadT > 0 && this.reloadItem === item) {
      if (def.shellReload && (item.mag | 0) > 0) this._cancelReload(); // pump: fire interrupts the shell reload
      else return;
    }
    let shots = 0;
    while (now >= this.nextFire && shots < 3) {
      if ((item.mag | 0) <= 0) {
        this.buffer = 0;
        if ((item.reserve | 0) > 0) this.startReload(item, def);
        else this._dryFire(def);
        return;
      }
      if (this.nextFire < now - 0.12) this.nextFire = now;
      this.nextFire += 1 / Math.max(0.1, def.rate || 1);
      this._shoot(item, def, inp, ctx);
      shots++;
      this.buffer = 0;
      if (!def.auto) break;
    }
    if (shots > 0 && (item.mag | 0) <= 0 && (item.reserve | 0) > 0) this.autoReloadT = 0.3;
  }

  _dryFire(def) {
    const g = this.game;
    if (this.emptyT > 0) return;
    this.emptyT = 0.32;
    g.audio?.play?.('empty_click', { position: this._eye(), volume: 0.7 });
    if (this.noAmmoNoteT <= 0) {
      this.noAmmoNoteT = 4;
      g.hud?.notify?.(`Out of ammo: ${def.name}. Buy more at the gun shop.`, { duration: 2.5 });
    }
  }

  /** Spread cone (radians) for the shot. */
  _spread(def, aiming, ctx) {
    const p = this.game.player;
    let s = aiming ? def.spread * (def.aimSpread ?? 0.45) : (def.hipSpread ?? def.spread);
    if (ctx.driveBy) {
      const vs = Math.abs((ctx.vehicle && ctx.vehicle.speed) || 0);
      s *= 1.5 + Math.min(1.5, vs / 18);
    } else if (p) {
      const v = p.velocity;
      const sp = v ? Math.hypot(v.x, v.z) : 0;
      s *= 1 + Math.min(1.1, sp / 5.5);
      if (p.crouching) s *= 0.7;
      if (p.onGround === false && !p.inWater) s *= 2;
    }
    return s * (1 + this.bloom);
  }

  /** World-space muzzle position for the player's weapon into `out`. */
  muzzlePosition(def, aiming, ctx, out) {
    const g = this.game, p = g.player, rig = g.cameraRig;
    if (!p) return out.set(0, 0, 0);
    if (ctx && ctx.driveBy && ctx.vehicle) return this._carMuzzle(ctx.vehicle, out);
    const cam = g.camera;
    if (rig && rig.firstPerson && cam) {
      cam.updateMatrixWorld();
      _m4.extractRotation(cam.matrixWorld);
      _r.set(1, 0, 0).applyMatrix4(_m4);
      _u.set(0, 1, 0).applyMatrix4(_m4);
      _f.set(0, 0, -1).applyMatrix4(_m4);
      out.setFromMatrixPosition(cam.matrixWorld);
      const half = (FP_LEN[def.id] || 0.5) * 0.5;
      if (rig.scoped) out.addScaledVector(_u, -0.09).addScaledVector(_f, 0.45);
      else if (aiming) out.addScaledVector(_u, -0.05).addScaledVector(_f, 0.42 + half);
      else out.addScaledVector(_r, 0.2).addScaledVector(_u, -0.16).addScaledVector(_f, 0.44 + half);
      return this._unblock(this._eye(_t), out);
    }
    // third person: shoulder -> raised arm (pitched with the aim) -> gun muzzle offset
    const yaw = rig && Number.isFinite(rig.yaw) ? rig.yaw : (p.yaw || 0);
    const pitch = rig && Number.isFinite(rig.pitch) ? Math.max(-1.2, Math.min(1.2, rig.pitch)) : 0;
    _f.set(Math.sin(yaw), 0, Math.cos(yaw));
    _r.set(-Math.cos(yaw), 0, Math.sin(yaw));
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const crouch = p.crouching ? 1 : 0;
    const stepOff = Number.isFinite(p.stepOffset) ? p.stepOffset : 0;
    out.copy(p.position);
    out.y += SHOULDER_Y - stepOff - crouch * 0.14;
    out.addScaledVector(_r, SHOULDER_X).addScaledVector(_f, crouch * 0.18);
    muzzleOffset(def.id, _mo);
    const along = ARM_LEN + _mo.z, upOff = _mo.y;
    // arm direction = f*cos(pitch) + up*sin(pitch); the gun's up = -f*sin(pitch) + up*cos(pitch)
    out.x += _f.x * (cp * along - sp * upOff);
    out.z += _f.z * (cp * along - sp * upOff);
    out.y += sp * along + cp * upOff;
    // prefer the real barrel tip of the held model (flash + tracer leave the visible gun, also while the arm is
    // still rising for a hip-fire shot); the analytic hand position is the fallback / sanity reference
    const held = p.humanoid && p.humanoid.held;
    if (held && p.humanoid.root && p.humanoid.root.visible !== false) {
      try {
        held.updateWorldMatrix(true, false);
        _hm.copy(_mo).applyMatrix4(held.matrixWorld);
        if (_hm.distanceToSquared(out) < 1.6 * 1.6) out.copy(_hm);
      } catch (e) { /* model not ready */ }
    }
    const chest = _t.set(p.position.x, p.position.y + 1.25 - crouch * 0.2, p.position.z);
    return this._unblock(chest, out);
  }

  /** If a wall is between `from` and the muzzle, pull the muzzle back in front of the wall (bullets hit it). */
  _unblock(from, muzzle) {
    const w = this.game.world;
    if (!w) return muzzle;
    _u.subVectors(muzzle, from);
    const len = _u.length();
    if (len < 1e-3) return muzzle;
    _u.divideScalar(len);
    let h = null;
    try { h = voxelRaycast(w, from, _u, len, { hitNonSolid: false }); } catch (e) { h = null; }
    if (h) muzzle.copy(from).addScaledVector(_u, Math.max(0, h.distance - 0.06));
    return muzzle;
  }

  /** Drive-by muzzle: where the aim direction leaves the car's box, at window height. */
  _carMuzzle(v, out) {
    const r = this._ray;
    const size = (v.def && v.def.size) || { w: 2, h: 1.5, l: 4.4 };
    const yaw = v.yaw || 0;
    let dx = r.dir.x, dz = r.dir.z;
    const hl = Math.hypot(dx, dz) || 1;
    dx /= hl; dz /= hl;
    const fl = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const rl = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
    const tl = Math.abs(fl) > 1e-3 ? (size.l * 0.5) / Math.abs(fl) : Infinity;
    const tw = Math.abs(rl) > 1e-3 ? (size.w * 0.5) / Math.abs(rl) : Infinity;
    const t = Math.min(tl, tw) + 0.3;
    out.set(v.position.x + dx * t, v.position.y + Math.max(1.05, size.h * 0.72), v.position.z + dz * t);
    return out;
  }

  _ignoreList(ctx) {
    const p = this.game.player;
    return ctx && ctx.vehicle ? [p, ctx.vehicle] : p;
  }

  /** Start distance along the aim ray: skip what is between the camera and the player. */
  _aimStart(ray, ctx) {
    const g = this.game, p = g.player, rig = g.cameraRig;
    if (!p || (rig && rig.firstPerson && !(ctx && ctx.driveBy))) return 0;
    const c = ctx && ctx.vehicle ? ctx.vehicle.position : p.position;
    const cy = ctx && ctx.vehicle ? c.y + 1 : c.y + 1.3;
    const proj = (c.x - ray.origin.x) * ray.dir.x + (cy - ray.origin.y) * ray.dir.y + (c.z - ray.origin.z) * ray.dir.z;
    return Math.max(0, proj - (ctx && ctx.vehicle ? 0 : 0.35));
  }

  _shoot(item, def, inp, ctx) {
    const g = this.game, p = g.player, c = this.combat;
    const aiming = !!inp.aiming;
    item.mag = (item.mag | 0) - 1;
    const ray = this._aimRay();
    const ignore = this._ignoreList(ctx);
    const target = this._target;
    c.ballistics.resolveAim(ray.origin, ray.dir, def.range || 150, ignore, this._aimStart(ray, ctx), target);
    const muzzle = this.muzzlePosition(def, aiming, ctx, this._muzzle);
    const sd = this._dir.subVectors(target, muzzle);
    const dist = sd.length();
    if (dist < 0.5) sd.copy(ray.dir);
    else {
      sd.divideScalar(dist);
      if (sd.dot(ray.dir) < 0.25) sd.copy(ray.dir);
    }
    const spread = this._spread(def, aiming, ctx);

    if (def.kind === 'projectile') {
      const d = spreadDir(sd, spread, this._pd, 1.6);
      const start = _t.copy(muzzle).addScaledVector(d, 0.1);
      c.projectiles.launchRocket(p, start, d, { ignore: Array.isArray(ignore) ? ignore : [ignore], weapon: def.id });
      // back-blast: a hot spark spray right behind the tube and one puff well behind (keeps the camera clear)
      const back = _t.copy(muzzle).addScaledVector(sd, -(FP_LEN.rpg + 0.25));
      try {
        g.fx?.burst?.(back, { color: 0xffb050, count: 8, speed: 5, size: 0.07, life: 0.25, gravity: 2, glow: true });
        back.addScaledVector(sd, -1.4);
        back.y -= 0.6;
        g.fx?.smoke?.(back, { amount: 1.2, color: 0xcfcac2 });
      } catch (e) { /* fx */ }
    } else {
      const pellets = def.pellets || 1;
      const hits = this._hits;
      hits.length = 0;
      for (let k = 0; k < pellets; k++) {
        const d = spreadDir(sd, spread, this._pd, pellets > 1 ? 1 : 1.7);
        const rec = c.ballistics.trace(muzzle, d, def.range || 150, ignore, p, this._rec);
        if (rec.kind === 'entity' && rec.entity) this._accumulate(rec, d, def);
        if (pellets === 1 || k < 4) { try { g.fx?.tracer?.(muzzle, rec.point, def.tracer); } catch (e) { /* fx */ } }
      }
      let confirm = 0;
      for (const h of hits) {
        c.ballistics.applyEntityHit(h, p, def);
        if (h.entity && h.entity.kind !== 'vehicle' && h.entity.kind !== 'heli') confirm = Math.max(confirm, h.headshot ? 2 : 1);
      }
      if (confirm) g.audio?.play?.('punch', { volume: confirm > 1 ? 0.45 : 0.28, pitch: confirm > 1 ? 2.1 : 1.7 });
      for (const h of hits) this._hitPool.push(h);
      hits.length = 0;
    }

    // flash, light, sound, brass, smoke
    try { g.fx?.muzzleFlash?.(muzzle, sd); } catch (e) { /* fx */ }
    c.flashLight(muzzle, sd, def.flash || 1);
    g.audio?.play?.(def.sound || 'gunshot_pistol', { position: muzzle, volume: 1, pitch: 0.97 + Math.random() * 0.06 });
    if (def.kind === 'hitscan') this._afterShot(def, muzzle, sd, ctx);

    // recoil + shake + bloom
    const rig = g.cameraRig;
    let rk = aiming ? 0.75 : 1;
    if (p && p.crouching) rk *= 0.8;
    if (ctx.driveBy) rk *= 1.2;
    try { rig?.addRecoil?.((def.recoil || 0.02) * rk, (Math.random() * 2 - 1) * (def.recoilYaw || 0.01) * rk); } catch (e) { /* camera */ }
    if (def.shake) { try { rig?.shake?.(def.shake); } catch (e) { /* camera */ } }
    this.bloom = Math.min(1.6, this.bloom + (def.bloom ?? 0.3));

    p?.noteAction?.();
    this._notifyInventory();
    g.events.emit('weaponFired', { weapon: def.id, byPlayer: true });
    g.events.emit('gunfire', { shooter: p, position: muzzle.clone(), weapon: def.id });
  }

  /** Casings, barrel smoke and pump / bolt-action sounds after a hitscan shot. */
  _afterShot(def, muzzle, sd, ctx) {
    const g = this.game, c = this.combat, p = g.player;
    _r.set(-sd.z, 0, sd.x);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    const port = _t.copy(muzzle).addScaledVector(sd, -(FP_LEN[def.id] || 0.5) * 0.45);
    port.y += 0.03;
    const carrier = ctx.driveBy && ctx.vehicle ? ctx.vehicle.velocity : p && p.velocity;
    const delay = def.id === 'shotgun' ? 0.32 : def.id === 'sniper' ? 0.5 : 0;
    const fp = !!(g.cameraRig && g.cameraRig.firstPerson);
    c.casings.eject(port, _r, sd, def.id, carrier || null, delay, fp ? 0.45 : 1);
    if (delay > 0) c.queueSound('reload', delay - 0.08, { volume: 0.5, pitch: def.id === 'shotgun' ? 1.55 : 1.3 });
    if (def.id === 'shotgun' || def.id === 'sniper' || Math.random() < 0.12) {
      try { g.fx?.smoke?.(muzzle, { amount: def.id === 'shotgun' ? 1.6 : 0.7, color: 0xd0d0d0 }); } catch (e) { /* fx */ }
    }
  }

  /** Merge pellet hits per entity for one trigger pull. */
  _accumulate(rec, d, def) {
    const e = rec.entity;
    let dmg = (def.damage || 10) * falloff(def, rec.distance);
    let head = false;
    if (isHumanoid(e) && e.alive !== false && e.position && Number.isFinite(e.height)) {
      head = rec.point.y > e.position.y + e.height * 0.83;
      if (head) dmg *= def.headshot ?? 2;
    }
    for (const h of this._hits) {
      if (h.entity === e) { h.damage += dmg; h.headshot = h.headshot || head; h.pellets++; return; }
    }
    const h = this._hitPool.pop() || { entity: null, damage: 0, point: new THREE.Vector3(), dir: new THREE.Vector3(), headshot: false, pellets: 0 };
    h.entity = e; h.damage = dmg; h.headshot = head; h.pellets = def.pellets ? 1 : 0;
    h.point.copy(rec.point); h.dir.copy(d);
    this._hits.push(h);
  }

  // ------------------------------------------------------------------------------------------- melee (bat)

  _melee(item, def, inp) {
    const g = this.game, p = g.player;
    const want = inp.firingPressed || (def.auto && inp.firing);
    if (!want || g.time < this.nextFire || this._drawLeft() > 0 || this.pendingSwing) return;
    this.nextFire = g.time + 1 / Math.max(0.2, def.rate || 1.5);
    p?.humanoid?.punch?.();
    p?.noteAction?.();
    g.audio?.play?.('melee_swing', { position: this._eye(), volume: 0.75, pitch: 0.78 + Math.random() * 0.08 });
    g.events.emit('weaponFired', { weapon: def.id, byPlayer: true });
    this.pendingSwing = { t: 0.1, def };
  }

  _resolveSwing(s) {
    const g = this.game, p = g.player;
    if (!p || p.alive === false || p.inVehicle) return;
    const def = s.def;
    const eye = this._eye(new THREE.Vector3());
    const dir = this._aimRay().dir.clone();
    const hit = this.combat.melee(p, eye, dir, def.damage, def.range || 2.8, { weapon: def.id, knockback: def.knockback });
    if (hit) { g.cameraRig?.shake?.(0.14); return; }
    const w = g.world;
    if (!w) return;
    let vh = null;
    try { vh = voxelRaycast(w, eye, dir, def.range || 2.8, { hitNonSolid: false }); } catch (e) { vh = null; }
    if (!vh) return;
    if (GLASS_IDS.has(vh.id)) { this.combat.ballistics.shatter(vh.x, vh.y, vh.z, vh.id, p, dir); return; }
    g.audio?.play?.('block_hit', { position: vh.point, volume: 0.8, pitch: 0.7 });
    try { g.fx?.impact?.(vh.point, vh.normal, vh.id); } catch (e) { /* fx */ }
    g.cameraRig?.shake?.(0.08);
  }

  // ------------------------------------------------------------------------------------------- grenades

  /** Origin + launch velocity of a player grenade throw (shared by the throw and the preview arc). */
  _throwParams(outPos, outVel) {
    const g = this.game, p = g.player, rig = g.cameraRig;
    const ray = this._aimRay();
    const def = WEAPONS.grenade;
    if (rig && rig.firstPerson) {
      outPos.copy(ray.origin);
      _r.set(-ray.dir.z, 0, ray.dir.x).normalize(); // camera right on the ground plane
      outPos.addScaledVector(_r, 0.22).addScaledVector(ray.dir, 0.3);
      outPos.y -= 0.12;
      this._unblock(this._eye(_t), outPos);
    } else {
      const yaw = rig && Number.isFinite(rig.yaw) ? rig.yaw : (p.yaw || 0);
      _f.set(Math.sin(yaw), 0, Math.cos(yaw));
      _r.set(-Math.cos(yaw), 0, Math.sin(yaw));
      outPos.copy(p.position);
      outPos.y += 1.55;
      outPos.addScaledVector(_r, 0.28).addScaledVector(_f, 0.3);
      this._unblock(_t.set(p.position.x, p.position.y + 1.3, p.position.z), outPos);
    }
    outVel.copy(ray.dir).multiplyScalar(def.throwSpeed || 18);
    outVel.y += GRENADE.upBoost;
    if (p && p.velocity) outVel.addScaledVector(p.velocity, 0.5);
    return outVel;
  }

  _grenadeWeapon(item, def, inp, ctx) {
    const g = this.game;
    if (ctx.driveBy) return;
    if (inp.aiming) {
      const s = this._gs;
      this._throwParams(s.pos, s.vel);
      this.arc.show(s.pos, s.vel);
    }
    if (inp.firingPressed && g.time >= this.nextFire && this._drawLeft() <= 0) {
      if (this.throwFromPlayer(item)) this.nextFire = g.time + 1 / Math.max(0.2, def.rate || 1.2);
    }
  }

  /** Throw one of the player's grenades (G key or LMB with the grenade selected). Returns true if thrown. */
  throwFromPlayer(item) {
    const g = this.game, p = g.player, c = this.combat;
    if (!p || p.alive === false || p.inVehicle) return false;
    if (!item) item = g.inventory?.getWeapon?.('grenade') || null;
    if (!item || ((item.mag | 0) + (item.reserve | 0)) <= 0) {
      if (this.emptyT <= 0) {
        this.emptyT = 0.5;
        g.audio?.play?.('empty_click', { volume: 0.5 });
        g.hud?.notify?.('No grenades', { duration: 1.5 });
      }
      return false;
    }
    if (g.time < this.grenadeNext) return false;
    this.grenadeNext = g.time + 0.55;
    const s = this._gs;
    this._throwParams(s.pos, s.vel);
    // throwGrenade adds up*4 + the thrower's velocity itself: hand it the pure aim direction + the matching power
    const ray = this._aimRay();
    const gr = c.projectiles.throwGrenade(p, s.pos, ray.dir, WEAPONS.grenade.throwSpeed || 18);
    if (!gr) return false;
    if ((item.mag | 0) > 0) item.mag--; else item.reserve--;
    if ((item.mag | 0) <= 0 && (item.reserve | 0) > 0) { item.mag = 1; item.reserve--; }
    this._notifyInventory();
    p.humanoid?.punch?.();
    p.noteAction?.();
    g.audio?.play?.('melee_swing', { position: s.pos, volume: 0.55, pitch: 1.25 });
    g.events.emit('weaponFired', { weapon: 'grenade', byPlayer: true });
    return true;
  }

  // ------------------------------------------------------------------------------------------- RPG warhead

  _syncWarhead(item) {
    const g = this.game;
    const show = (item.mag | 0) > 0 || (this.isReloading() && (this.reloadProgress() || 0) > 0.55);
    const objs = [g.player?.humanoid?.held, g.cameraRig?.viewModel?.current];
    for (const o of objs) {
      if (!o || !o.isObject3D) continue;
      let wh = this._warheads.get(o);
      if (wh === undefined) {
        wh = null;
        o.traverse((c) => { if (!wh && c.name === 'warhead') wh = c; });
        this._warheads.set(o, wh);
      }
      if (wh && wh.visible !== show) wh.visible = show;
    }
  }
}
