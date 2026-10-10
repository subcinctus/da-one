// Officer: one police officer on foot (entity kind 'cop', team 'police'). POLICE agent. Managed by Police.
//
// States:  exit     just got out of the car (short beat before acting)
//          engage   deal with the player according to Police.policy: 'arrest' (run up, grab, punch if resisting),
//                   'shoot' (keep 6-15 m, strafe, fire bursts with a reaction delay, only with line of sight),
//                   or search around the last known position when the player is out of sight
//          return   run back to the unit's car and board it (the car then resumes the chase)
//          hold     BUSTED: surround the player at gunpoint
//          guard    stand at a post (police station)
//          leave    the chase is over: walk away (Police despawns us out of view)
//          knocked  on the ground after a big hit (car, explosion)
//          dead     corpse (Police despawns it later)
import * as THREE from 'three';
import { Humanoid, LOOKS, HUMANOID_HEIGHT, HUMANOID_RADIUS } from '../entities/humanoid.js';
import { moveBox } from '../core/physics.js';
import { PHYS } from '../core/config.js';
import { clamp, angleDiff } from '../core/math.js';
import { OFFICER_TYPES, LEVELS, TUNE } from './police_const.js';
import { rand, randInt, chance, aimShot, isWaterAt, hdist, speedOf } from './police_util.js';

const _d = new THREE.Vector3();
const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tp = new THREE.Vector3();

let _pistolGeo = null;
const PISTOL_MAT = new THREE.MeshLambertMaterial({ color: 0x1e2024 });

/** Third-person weapon model (combat's voxel model when available, else a tiny box pistol). */
export function officerWeaponModel(game, id) {
  try {
    const m = game.combat && typeof game.combat.getWeaponViewModel === 'function' ? game.combat.getWeaponViewModel(id) : null;
    if (m && m.isObject3D) return m.parent ? m.clone() : m;
  } catch (e) { /* combat stub */ }
  if (!_pistolGeo) {
    const a = new THREE.BoxGeometry(0.07, 0.09, 0.26).translate(0, 0.02, 0.1);
    const b = new THREE.BoxGeometry(0.06, 0.15, 0.07).translate(0, -0.07, 0);
    _pistolGeo = new THREE.BufferGeometry();
    const pa = a.toNonIndexed(), pb = b.toNonIndexed();
    const pos = new Float32Array(pa.attributes.position.count * 3 + pb.attributes.position.count * 3);
    pos.set(pa.attributes.position.array, 0); pos.set(pb.attributes.position.array, pa.attributes.position.count * 3);
    const nor = new Float32Array(pos.length);
    nor.set(pa.attributes.normal.array, 0); nor.set(pb.attributes.normal.array, pa.attributes.normal.count * 3);
    _pistolGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    _pistolGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    a.dispose(); b.dispose(); pa.dispose(); pb.dispose();
  }
  return new THREE.Mesh(_pistolGeo, PISTOL_MAT);
}

export class Officer {
  /**
   * @param {Police} police owner system
   * @param {THREE.Vector3} pos feet position
   * @param {object} opts {swat, unit (PoliceCar), yaw, state, post {x,y,z,yaw}}
   */
  constructor(police, pos, opts = {}) {
    this.police = police;
    this.game = police.game;
    this.swat = !!opts.swat;
    this.def = OFFICER_TYPES[this.swat ? 'swat' : 'cop'];
    // ---- entity interface (§3.3)
    this.id = undefined;
    this.kind = 'cop';
    this.team = 'police';
    this.position = new THREE.Vector3().copy(pos);
    this.velocity = new THREE.Vector3();
    this.radius = HUMANOID_RADIUS;
    this.height = HUMANOID_HEIGHT;
    this.maxHealth = this.def.health;
    this.health = this.maxHealth;
    this.alive = true;
    this.hidden = false;
    // ---- ownership
    this.unit = opts.unit || null;
    this.post = opts.post || null;
    this.cover = opts.cover || null;   // {x, z}: hold this spot while the unit is a roadblock
    this.prefersCover = Math.random() < (opts.swat ? 0.4 : 0.55); // fight from behind the cruiser when possible
    this.coverSide = Math.random() < 0.5 ? -1 : 1;
    this.noLosT = 0;
    // ---- model
    this.humanoid = new Humanoid(LOOKS[this.def.look] || LOOKS.cop);
    this.game.scene.add(this.humanoid.root);
    this.weapon = this.def.weapon;
    this.humanoid.setHeld(officerWeaponModel(this.game, this.weapon));
    // ---- motion
    this.yaw = Number.isFinite(opts.yaw) ? opts.yaw : Math.random() * Math.PI * 2;
    this.dvx = 0; this.dvz = 0;
    this.moveSpeed = 0;
    this.goalX = pos.x; this.goalZ = pos.z; this.hasGoal = false;
    this.onGround = true;
    this.inWater = false;
    this.hspeed = 0;
    this._out = {};
    this.blockedT = 0;
    this.sideT = 0; this.sideDir = 1;
    // ---- brain
    this.state = opts.state || 'engage';
    this.stateT = 0;
    this.thinkT = Math.random() * 0.2;
    this.los = false;
    this.losT = Math.random() * TUNE.LOS_INTERVAL;
    this.aimT = 0;
    this.aiming = false;
    this.aimPitch = 0;
    this.faceTarget = false;
    this.strafeDir = chance(0.5) ? 1 : -1;
    this.strafeT = rand(1.4, 3);
    this.burst = 0;
    this.shotT = 0;
    this.cd = rand(0.2, 0.8);
    this.mag = this.def.mag;
    this.reloadT = 0;
    this.hasToken = false;
    this.punchCd = rand(0.5, 0.9);
    this.knockT = 0;
    this.afterKnock = 'engage';
    this.deadT = 0;
    this.hurtCd = 0;
    this.removed = false;
    this.searchX = pos.x; this.searchZ = pos.z; this.searchT = 0;
    const pl = this.game.player;
    const pp = pl && pl.position ? (pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position) : null;
    this.distToPlayer = pp ? hdist(this.position, pp) : 999;
    this.ring = Math.random() * Math.PI * 2;  // angle around the player when surrounding (busted)
    this.humanoid.root.position.copy(this.position);
    this.humanoid.root.rotation.y = this.yaw;
  }

  // ============================================================================================ entity API

  /** World AABB: standing box, or a flat box along the body when down. */
  getBox(out) {
    const p = this.position;
    if (this.alive && this.state !== 'knocked') {
      out.min.set(p.x - this.radius, p.y, p.z - this.radius);
      out.max.set(p.x + this.radius, p.y + this.height, p.z + this.radius);
      return out;
    }
    const bx = p.x - Math.sin(this.yaw) * 1.7, bz = p.z - Math.cos(this.yaw) * 1.7;
    out.min.set(Math.min(p.x, bx) - 0.35, p.y, Math.min(p.z, bz) - 0.35);
    out.max.set(Math.max(p.x, bx) + 0.35, p.y + 0.5, Math.max(p.z, bz) + 0.35);
    return out;
  }

  /** Take damage (bullets, punches, cars, explosions). Emits entityDamaged / entityKilled. */
  damage(amount, info = {}) {
    amount = Number(amount);
    if (!(amount > 0) || this.removed) return;
    info = info || {};
    const g = this.game;
    const chest = _o.set(this.position.x, this.position.y + 1.25, this.position.z);
    if (!this.alive) {
      if (info.type === 'bullet' || info.type === 'melee') { try { g.fx?.blood?.(info.point || chest, info.dir || _d.set(0, 1, 0)); } catch (e) { /* fx stub */ } }
      return;
    }
    if (this.def.armor > 0 && (info.type === 'bullet' || info.type === 'explosion')) amount *= 1 - this.def.armor;
    // friendly fire / own cars: mostly harmless (cops do not kill each other in a chase)
    const src = info.source;
    if (src && src !== g.player && (src.team === 'police' || src.isPolice)) amount *= info.type === 'explosion' ? 0.5 : 0.2;
    this.health -= amount;
    this.humanoid.flash();
    try { g.fx?.blood?.(info.point || chest, info.dir || _d.set(Math.random() - 0.5, 0.6, Math.random() - 0.5)); } catch (e) { /* fx stub */ }
    if (info.dir && info.type !== 'vehicle' && info.type !== 'explosion') {
      const k = info.type === 'melee' ? 2.2 : 1.0;
      this.velocity.x += info.dir.x * k; this.velocity.z += info.dir.z * k;
    }
    g.events.emit('entityDamaged', { entity: this, amount, info });
    if (this.health <= 0) { this.die(info); return; }
    if (this.hurtCd <= 0) {
      this.hurtCd = 0.5;
      g.audio?.play?.('hurt', { position: this.position, volume: 0.5, pitch: rand(0.8, 0.95) });
    }
    // being shot sharpens the aim: they know exactly where it came from
    if (src === g.player) { this.aimT = Math.max(this.aimT, 0.6); this.cd = Math.min(this.cd, 0.4); }
    this.police.onOfficerHurt(this, info);
  }

  /** Physical push (velocity change, m/s). Big pushes knock the officer down for a moment. */
  knockback(impulse) {
    if (!impulse || this.removed) return;
    this.velocity.add(impulse);
    const h = Math.hypot(this.velocity.x, this.velocity.z);
    if (h > 20) { this.velocity.x *= 20 / h; this.velocity.z *= 20 / h; }
    this.velocity.y = clamp(this.velocity.y, -30, 13);
    if (this.velocity.y > 0.5) this.onGround = false;
    const mag = Math.hypot(impulse.x, impulse.y || 0, impulse.z);
    if (this.alive && mag > 4.5) {
      if (this.state !== 'knocked') this.afterKnock = this.state === 'hold' || this.state === 'guard' ? 'engage' : this.state;
      this.setState('knocked');
      this.knockT = rand(1.2, 2.0);
      this.yaw = Math.atan2(-impulse.x, -impulse.z);
      this._dropToken();
    }
  }

  die(info) {
    const g = this.game;
    this.alive = false;
    this.health = 0;
    this.setState('dead');
    this.deadT = 0;
    this.height = 0.5;
    this.aiming = false;
    this._dropToken();
    this.humanoid.setHeld(null);
    g.events.emit('entityKilled', { entity: this, info });
    g.audio?.play?.('death', { position: this.position, volume: 0.9, pitch: rand(0.8, 0.95) });
    try {
      const c = _o.set(this.position.x, this.position.y + 1, this.position.z);
      g.fx?.blood?.(c, _d.set(0, 1, 0));
      g.fx?.blood?.(c, _d.set(Math.random() - 0.5, 0.4, Math.random() - 0.5));
    } catch (e) { /* fx stub */ }
    this.police.onOfficerDown(this, info);
  }

  /** Remove from the world (boarding a car, despawn). Safe to call twice. */
  despawn() {
    if (this.removed) return;
    this.removed = true;
    this._dropToken();
    this.game.entities?.remove?.(this);
    if (this.humanoid) {
      this.humanoid.setHeld(null);
      this.humanoid.dispose();
    }
  }

  setState(s) {
    if (this.state === s) return;
    if (s !== 'engage') this._dropToken();
    this.state = s;
    this.stateT = 0;
    this.hasGoal = false;
  }

  _dropToken() {
    if (this.hasToken) this.police.releaseToken(this);
    this.burst = 0;
  }

  // ============================================================================================ frame

  update(dt) {
    if (this.removed) return;
    const g = this.game;
    this.stateT += dt;
    this.hurtCd -= dt;
    if (!this.alive) {
      this.deadT += dt;
      this._physics(dt, 0, 0, 0);
      this.humanoid.root.position.copy(this.position);
      this.humanoid.root.rotation.y = this.yaw;
      this.humanoid.animate(dt, { state: 'dead' });
      return;
    }
    const pl = g.player;
    if (pl && pl.position) {
      const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
      this.distToPlayer = hdist(this.position, pp);
    }
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.16 + Math.random() * 0.08;
      this._think();
      if (this.removed) return; // boarded a car
    }
    if (this.state === 'knocked') {
      this.knockT -= dt;
      this.hasGoal = false;
      if (this.knockT <= 0) this.setState(this.afterKnock || 'engage');
    }
    this._combat(dt);
    this._steer(dt);
    this._animate(dt);
  }

  // ============================================================================================ decisions

  _think() {
    const P = this.police, g = this.game, pl = g.player;
    const alivePlayer = !!(pl && pl.alive !== false && pl.position);
    const pp = alivePlayer ? (pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position) : null;
    switch (this.state) {
      case 'exit':
        this.hasGoal = false;
        if (this.stateT > 0.45) this.setState('engage');
        break;
      case 'engage': {
        if (!alivePlayer || P.wanted <= 0) { this.setState(this.unit && this.unit.carAlive ? 'return' : this.post ? 'guard' : 'leave'); break; }
        if (P.busting) { this.setState('hold'); break; }
        const known = P.knows || this.los;
        const policy = P.policy;
        const d = this.distToPlayer;
        this.faceTarget = this.los;
        if (!known) {
          // search: jog between points around the last known position
          this.faceTarget = false;
          this.searchT -= 0.2;
          if (this.searchT <= 0 || Math.hypot(this.searchX - this.position.x, this.searchZ - this.position.z) < 2.5) {
            const r = P.searchRadius() * 0.45;
            const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
            this.searchX = P.lastKnown.x + Math.cos(a) * rr;
            this.searchZ = P.lastKnown.z + Math.sin(a) * rr;
            this.searchT = rand(5, 9);
          }
          this._goal(this.searchX, this.searchZ, 3.6);
        } else if (policy === 'arrest') {
          const car = pl.inVehicle;
          if (car && car.position && typeof car.getDoorPosition === 'function' && speedOf(car) < TUNE.CAR_BUST_SPEED &&
            !(car.isHeli && car.onGround === false)) {
            // suspect sitting in a stopped car: walk up to the driver door (Police pulls them out from there)
            car.getDoorPosition(_tp, 1, 0.6);
            const dd = Math.hypot(_tp.x - this.position.x, _tp.z - this.position.z);
            if (dd > 0.6) {
              this._carDetour(car, _tp);
              this._goal(_tp.x, _tp.z, dd < 3.2 ? this.def.walk * 1.6 : this.def.run);
            } else this.hasGoal = false;
          } else {
            const close = d < 3.2;
            if (d > 1.15) this._goal(pp.x, pp.z, close ? this.def.walk * 1.6 : this.def.run);
            else this.hasGoal = false;
          }
          this.faceTarget = d < 14;
        } else if (this.cover && this.unit && this.unit.state === 'roadblock' && d > 9) {
          // roadblock: stay behind the cruisers and shoot from cover until the suspect is right on top of us
          const cx = this.cover.x, cz = this.cover.z;
          if (Math.hypot(cx - this.position.x, cz - this.position.z) > 0.7) this._goal(cx, cz, this.def.run * 0.7);
          else this.hasGoal = false;
          this.faceTarget = true;
        } else if (policy === 'shoot') {
          const [minR, maxR] = this.def.keep;
          const px = this.position.x, pz = this.position.z;
          const dx = pp.x - px, dz = pp.z - pz, len = Math.hypot(dx, dz) || 1;
          const ux = dx / len, uz = dz / len;
          this.noLosT = this.los ? 0 : this.noLosT + 0.2;
          this.peekT = (this.peekT || 0) - 0.2;
          if (this.noLosT >= 1.8 && this.peekT <= 0) this.peekT = rand(2.5, 4); // blind behind cover: step out a while
          const car = this.unit && this.unit.carAlive ? this.unit.vehicle : null;
          const carD = car ? Math.hypot(car.position.x - pp.x, car.position.z - pp.z) : 0;
          if (car && this.prefersCover && this.peekT <= 0 && carD > minR && carD < maxR + 8 && hdist(car.position, this.position) < 14) {
            // cover-ish: crouch behind our cruiser on the side away from the suspect (peek out when blind)
            const ax = car.position.x - pp.x, az = car.position.z - pp.z, l = Math.hypot(ax, az) || 1;
            const off = (car.def ? car.def.size.l * 0.5 : 2.3) + 1.0;
            const tx = car.position.x + (ax / l) * off - (az / l) * this.coverSide * 1.3;
            const tz = car.position.z + (az / l) * off + (ax / l) * this.coverSide * 1.3;
            if (Math.hypot(tx - px, tz - pz) > 0.7) this._goal(tx, tz, this.def.run * 0.8);
            else this.hasGoal = false;
          } else if (!this.los) {
            // regain line of sight: close in on where they were last seen (or are)
            const tx = P.knows ? pp.x : P.lastKnown.x, tz = P.knows ? pp.z : P.lastKnown.z;
            this._goal(tx, tz, this.def.run * 0.9);
          } else if (d > maxR) {
            this._goal(pp.x, pp.z, d > maxR + 12 ? this.def.run * 0.85 : 3.4);
          } else if (d < minR) {
            this._goal(px - ux * 4, pz - uz * 4, 2.8);
          } else {
            this.strafeT -= 0.2;
            if (this.strafeT <= 0) { this.strafeT = rand(1.3, 3.0); if (chance(0.6)) this.strafeDir *= -1; }
            // right of the line to the player is (-uz, ux)
            this._goal(px - uz * 3 * this.strafeDir, pz + ux * 3 * this.strafeDir, this.def.strafe);
          }
        } else {
          this.hasGoal = false;
        }
        // drivers return when the suspect drives off (the unit tells us via recall)
        if (this.unit && this.unit.recalling) this.setState('return');
        break;
      }
      case 'return': {
        const u = this.unit;
        if (!u || !u.carAlive) { this.unit = null; this.setState(P.wanted > 0 ? 'engage' : this.post ? 'guard' : 'leave'); break; }
        const door = u.doorPoint(this, _tp);
        const d = Math.hypot(door.x - this.position.x, door.z - this.position.z);
        if (d < 1.7 || (this.stateT > 12 && d < 4)) { u.board(this); return; }
        this._goal(door.x, door.z, this.def.run);
        this.faceTarget = false;
        // the chase came back to us: fight instead of boarding
        if (P.wanted > 0 && alivePlayer && !pl.inVehicle && this.distToPlayer < 12 && !u.recalling) this.setState('engage');
        break;
      }
      case 'hold': {
        if (!P.busting) { this.setState(P.wanted > 0 ? 'engage' : 'leave'); break; }
        if (!pp) break;
        const r = 2.6 + (this.id % 3) * 0.7;
        const tx = pp.x + Math.cos(this.ring) * r, tz = pp.z + Math.sin(this.ring) * r;
        if (Math.hypot(tx - this.position.x, tz - this.position.z) > 0.6) this._goal(tx, tz, 3.2); else this.hasGoal = false;
        this.faceTarget = true;
        break;
      }
      case 'guard': {
        const post = this.post;
        if (P.wanted > 0 && alivePlayer && (this.los || this.distToPlayer < 25) && this.distToPlayer < 55) { this.setState('engage'); break; }
        if (post && Math.hypot(post.x - this.position.x, post.z - this.position.z) > 0.8) this._goal(post.x, post.z, this.def.walk);
        else {
          this.hasGoal = false;
          if (post) {
            // idle look-around
            if (this.stateT % 6 < 0.2) this._lookYaw = post.yaw + rand(-0.8, 0.8);
          }
        }
        this.faceTarget = false;
        break;
      }
      case 'leave': {
        if (P.wanted > 0 && alivePlayer && this.distToPlayer < 45) { this.setState('engage'); break; }
        const u = this.unit;
        if (u && u.carAlive && u.wantsCrew) { this.setState('return'); break; }
        if (this.post) { this.setState('guard'); break; }
        // stroll away from the player
        if (pp && (!this.hasGoal || this.stateT > 8)) {
          const ax = this.position.x - pp.x, az = this.position.z - pp.z, l = Math.hypot(ax, az) || 1;
          this._goal(this.position.x + (ax / l) * 30 + rand(-6, 6), this.position.z + (az / l) * 30 + rand(-6, 6), this.def.walk);
          this.stateT = 0;
        }
        this.faceTarget = false;
        break;
      }
      default: break;
    }
  }

  _goal(x, z, speed) {
    this.goalX = x; this.goalZ = z; this.hasGoal = true; this.moveSpeed = speed;
  }

  /**
   * Walking to the driver door (local +x side) of `car`: officers do not collide with vehicles, so instead of cutting
   * through the body go around it: past the nearest end first, then along the driver side. Rewrites `door` (world
   * point) to the next waypoint when a detour is needed.
   */
  _carDetour(car, door) {
    const d = car.def && car.def.size ? car.def.size : { w: 2, l: 4.6 };
    const hw = d.w / 2, hl = d.l / 2;
    const sy = Math.sin(car.yaw), cy = Math.cos(car.yaw);
    const dx = this.position.x - car.position.x, dz = this.position.z - car.position.z;
    const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy;   // officer in the car's frame (+x = driver side)
    if (lx >= hw + 0.2) return;                           // already on the driver side: straight to the door
    const beside = Math.abs(lz) < hl + 0.5;
    if (beside && lx > -hw - 0.2) return;                 // standing in / against the body: shortest way out is sideways
    const end = lz >= 0 ? 1 : -1;
    // passenger side: walk along it past the nearest end; beyond an end: cut across to the driver-side corner
    const tx = beside ? Math.min(lx, -hw - 0.9) : hw + 0.9, tz = end * (hl + 1.1);
    door.set(car.position.x + tx * cy + tz * sy, door.y, car.position.z - tx * sy + tz * cy);
  }

  // ============================================================================================ combat

  _combat(dt) {
    const P = this.police, g = this.game, pl = g.player;
    this.aiming = false;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.mag = this.def.mag;
    }
    if (!pl || pl.alive === false || !pl.position) { this._dropToken(); this.aimT = 0; return; }
    const d = this.distToPlayer;
    if (this.state === 'hold') { this.aiming = this.los || d < 8; this._dropToken(); return; }
    if (this.state !== 'engage') { this._dropToken(); this.aimT = Math.max(0, this.aimT - dt); return; }
    const policy = P.policy;
    if (this.los) this.aimT += dt; else this.aimT = Math.max(0, this.aimT - dt * 2);
    if (policy === 'arrest') {
      this._dropToken();
      this.aiming = this.los && d < 14 && d > 1.4;
      // grab / punch a suspect who will not stop (or sits in a car)
      this.punchCd -= dt;
      if (d < 1.75 && this.punchCd <= 0 && !pl.inVehicle) {
        const resisting = speedOf(pl) > TUNE.BUST_SPEED;
        if (resisting) {
          this.punchCd = rand(1.0, 1.4);
          this._melee(pl);
        } else this.punchCd = 0.3;
      }
      return;
    }
    if (policy !== 'shoot') { this._dropToken(); return; }
    if (!this.los || d > this.def.range) {
      if (this.hasToken && this.burst <= 0) this._dropToken();
      return;
    }
    this.aiming = true;
    if (this.reloadT > 0) return;
    const L = LEVELS[P.wanted] || LEVELS[1];
    if (this.burst > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this._shoot(d);
        this.burst--;
        this.shotT = this.def.shotGap * rand(0.85, 1.3);
        if (this.burst <= 0) { this._dropToken(); this.cd = rand(L.pause[0], L.pause[1]); }
      }
      return;
    }
    this.cd -= dt;
    if (this.cd <= 0 && this.aimT >= L.react) {
      if (P.takeToken(this)) {
        this.burst = randInt(L.burst[0], L.burst[1]) + (this.swat ? 1 : 0);
        this.shotT = 0.03;
      } else this.cd = rand(0.25, 0.5);
    }
  }

  /** Muzzle position (right hand, gun raised). */
  muzzle(out) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // forward (s, c), right (-c, s)
    return out.set(this.position.x + s * 0.55 - c * 0.22, this.position.y + 1.42, this.position.z + c * 0.55 + s * 0.22);
  }

  _shoot(dist) {
    const P = this.police, g = this.game, pl = g.player;
    const origin = this.muzzle(_o);
    const pHit = P.shotHitChance(this, dist, this.aimT);
    aimShot(origin, pl, true, _dir);
    if (P.friendlyInLine(origin, _dir, dist, this)) {
      // a colleague (or our own cruiser) is in the way: hold fire and step out to a clear lane
      this.strafeDir *= -1;
      this.strafeT = rand(0.8, 1.4);
      this.peekT = rand(1.6, 2.8);
      return;
    }
    const hit = P.rollHit(pHit);
    if (!hit) aimShot(origin, pl, false, _dir);
    P.stats.shots++; P.stats.hitRolls += hit ? 1 : 0; P.stats.pSum += pHit;
    try { g.combat?.fire?.(this, origin, _dir, this.weapon); } catch (e) { /* combat stub */ }
    this.mag--;
    if (this.mag <= 0) {
      this.reloadT = this.def.reload;
      this.burst = 0;
      this._dropToken();
      g.audio?.play?.('reload', { position: this.position, volume: 0.6 });
    }
  }

  _melee(pl) {
    const g = this.game;
    this.humanoid.punch();
    const origin = _o.set(this.position.x, this.position.y + 1.35, this.position.z);
    const tx = pl.position.x - origin.x, tz = pl.position.z - origin.z;
    _dir.set(tx, pl.position.y + 1.1 - origin.y, tz).normalize();
    this.yaw = Math.atan2(tx, tz);
    try { g.combat?.melee?.(this, origin, _dir, 7, 2.0); } catch (e) { /* combat stub */ }
  }

  // ============================================================================================ movement

  _steer(dt) {
    const g = this.game, pl = g.player;
    let dvx = 0, dvz = 0;
    if (this.hasGoal && this.state !== 'knocked') {
      const dx = this.goalX - this.position.x, dz = this.goalZ - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.35) {
        let ux = dx / d, uz = dz / d;
        // side-step around whatever blocked us
        if (this.sideT > 0) {
          this.sideT -= dt;
          const sx = -uz * this.sideDir, sz = ux * this.sideDir;
          ux = ux * 0.35 + sx; uz = uz * 0.35 + sz;
          const l = Math.hypot(ux, uz) || 1; ux /= l; uz /= l;
        }
        const sp = this.moveSpeed * Math.min(1, d / 1.2 + 0.25);
        dvx = ux * sp; dvz = uz * sp;
        // never walk into water
        if (isWaterAt(g, this.position.x + ux * 1.2, this.position.z + uz * 1.2)) { dvx = 0; dvz = 0; this.hasGoal = false; }
      }
    }
    // separation from other officers and the player
    const sep = this.police.separation(this);
    dvx += sep.x; dvz += sep.z;
    this.dvx = dvx; this.dvz = dvz;
    const res = this._physics(dt, dvx, dvz, 1);
    // blocked by a wall while trying to move: side-step for a moment
    const want = Math.hypot(dvx, dvz);
    if (want > 0.8 && (res.hitX || res.hitZ) && this.hspeed < want * 0.4) {
      this.blockedT += dt;
      if (this.blockedT > 0.3 && this.sideT <= 0) { this.sideT = rand(0.6, 1.1); this.sideDir = chance(0.5) ? 1 : -1; this.blockedT = 0; this.strafeDir *= -1; }
    } else this.blockedT = Math.max(0, this.blockedT - dt);
    // facing
    let targetYaw = this.yaw;
    if ((this.faceTarget || this.aiming) && pl && pl.position) {
      const pp = pl.inVehicle && pl.inVehicle.position ? pl.inVehicle.position : pl.position;
      targetYaw = Math.atan2(pp.x - this.position.x, pp.z - this.position.z);
      const dy = (pl.inVehicle ? pp.y + 0.8 : pp.y + 1.2) - (this.position.y + 1.42);
      this.aimPitch = Math.atan2(dy, Math.max(0.5, this.distToPlayer));
    } else if (this.hspeed > 0.6) targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
    else if (this._lookYaw !== undefined && this.state === 'guard') targetYaw = this._lookYaw;
    const k = Math.min(1, dt * (this.aiming ? 12 : 8));
    this.yaw += angleDiff(this.yaw, targetYaw) * k;
  }

  /** Gravity + voxel collision. Returns the moveBox result. */
  _physics(dt, dvx, dvz, step) {
    const g = this.game, v = this.velocity;
    const world = g.world;
    const accel = this.onGround ? 24 : 5;
    const ax = clamp(dvx - v.x, -accel * dt, accel * dt), az = clamp(dvz - v.z, -accel * dt, accel * dt);
    if (this.state === 'knocked' || !this.alive) {
      const f = this.onGround ? Math.exp(-6 * dt) : 1;
      v.x *= f; v.z *= f;
    } else { v.x += ax; v.z += az; }
    v.y = Math.max(-PHYS.TERMINAL_VELOCITY, v.y - PHYS.GRAVITY * dt);
    if (this.inWater) { v.y = Math.max(v.y, -2); v.y += 26 * dt; v.x *= 0.96; v.z *= 0.96; }
    const res = world && typeof world.isSolid === 'function'
      ? moveBox(world, this.position, this.radius, 1.8, v, dt, { stepHeight: step && this.onGround ? 1.0 : 0 }, this._out)
      : (this.position.addScaledVector(v, dt), this._out);
    this.onGround = !!res.onGround;
    this.inWater = !!res.inWater;
    this.hspeed = Math.hypot(v.x, v.z);
    if (this.position.y < -20 && this.alive) this.damage(9999, { type: 'fall', source: null });
    return res;
  }

  _animate(dt) {
    const h = this.humanoid;
    h.root.position.copy(this.position);
    h.root.rotation.y = this.yaw;
    const st = this.state === 'knocked' ? 'dead' : this.inWater ? 'swim' : this.onGround ? 'normal' : 'air';
    h.animate(dt, { speed: this.hspeed, aiming: this.aiming, aimPitch: this.aimPitch, state: st, twoHanded: this.swat || this.aiming });
  }
}
