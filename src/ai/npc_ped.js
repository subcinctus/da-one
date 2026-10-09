// Ped: one pedestrian (entity kind 'ped', §3.3 / §Peds). NPC agent. Managed by Peds (src/ai/peds.js).
//
// Navigation modes:  'walk'   follows the sidewalk graph (nav.walk): edges, random turns at corners, crosswalks
//                    'wander' free roaming around an anchor (parks, plazas, beach, countryside hikers)
//                    'guard'  stands at a post (mission targets / bodyguards), small look-arounds
// Behaviour states:  walk, idle, chat, wait (curb), flee, cower, fight, shoot, dive, knocked, dead, return
// Combat / reaction logic lives in npc_pedai.js; this file holds the entity, movement, walking and animation.
import * as THREE from 'three';
import { Humanoid, LOOKS, randomLook, HUMANOID_HEIGHT, HUMANOID_RADIUS } from '../entities/humanoid.js';
import { moveBox } from '../core/physics.js';
import { PHYS } from '../core/config.js';
import { clamp, wrapAngle, angleDiff } from '../core/math.js';
import { nearestWalkEdge } from './nav.js';
import { rand, chance } from './npc_util.js';
import {
  thinkFlee, steerFlee, thinkFight, steerFight, thinkShoot, steerShoot, updateWeapon, checkDodge, crossSafe,
} from './npc_pedai.js';

const _out = { onGround: false };
const STEP1 = { stepHeight: 1 };
const STEP0 = { stepHeight: 0 };
const _ne = { edge: null, t: 0, d: 0, px: 0, pz: 0 };
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

const GANG_SKIN = [0x8d5524, 0xc68642, 0x6b4226, 0xe0ac69, 0xf1c27d];
const GANG_SHIRT = [0x6a1b9a, 0x4a148c, 0x7b1fa2, 0x311b92];

/** Calm states (no threat being handled). */
export const CALM = new Set(['walk', 'idle', 'chat', 'wait']);

export class Ped {
  /**
   * @param {Peds} sys owner
   * @param {THREE.Vector3} pos feet position
   * @param {object} opts {look, team, weapon, health, mood, target, persistent, yaw, mode, anchor, wanderR, knocked,
   *                       homeVehicle, gang}
   */
  constructor(sys, pos, opts = {}) {
    this.sys = sys;
    this.game = sys.game;
    // ---- entity interface
    this.id = undefined;
    this.kind = 'ped';
    this.team = opts.team || (opts.gang ? 'gang' : 'civilian');
    this.position = new THREE.Vector3().copy(pos);
    this.velocity = new THREE.Vector3();
    this.scale = opts.scale || rand(0.93, 1.06);
    this.radius = HUMANOID_RADIUS;
    this.height = HUMANOID_HEIGHT * this.scale;
    this.maxHealth = Number.isFinite(opts.health) ? opts.health : this.team === 'gang' ? 80 : 60;
    this.health = this.maxHealth;
    this.alive = true;
    this.hidden = false;
    this.persistent = !!opts.persistent;
    // ---- look / model
    let look = opts.look;
    if (!look) {
      if (this.team === 'gang') {
        look = { ...LOOKS.gang, skin: GANG_SKIN[Math.floor(Math.random() * GANG_SKIN.length)], shirt: GANG_SHIRT[Math.floor(Math.random() * GANG_SHIRT.length)] };
        if (chance(0.4)) look.hat = null;
      } else look = randomLook();
    }
    this.look = look;
    this.humanoid = new Humanoid(look);
    this.humanoid.root.scale.setScalar(this.scale);
    this.game.scene.add(this.humanoid.root);
    this.weapon = opts.weapon || null;
    if (this.weapon) this.humanoid.setHeld(sys.weaponModel(this.weapon));
    // ---- motion
    this.yaw = Number.isFinite(opts.yaw) ? opts.yaw : Math.random() * Math.PI * 2;
    this.targetYaw = this.yaw;
    this.dvx = 0; this.dvz = 0;           // desired horizontal velocity
    this.onGround = true;
    this.inWater = false;
    this.waterT = 0;
    this.stepOffset = 0;
    this.bumpT = 0;
    this.hspeed = 0;
    const old = look.hair === 0x9a9a9a;
    this.walkSpeed = old ? rand(0.95, 1.15) : rand(1.2, 1.6) * (this.team === 'gang' ? 0.85 : 1);
    this.runSpeed = old ? rand(4.6, 5.4) : rand(6.4, 7.4);
    // ---- navigation
    this.mode = opts.mode || 'walk';
    this.edge = null; this.fwd = true; this.es = 0;
    this.lat = rand(-0.1, 0.6);           // offset across the sidewalk (+ = away from the road)
    this.crossLat = rand(-0.6, 0.6);
    this.pendingEdge = null;
    this.anchorX = opts.anchor ? opts.anchor.x : pos.x;
    this.anchorZ = opts.anchor ? opts.anchor.z : pos.z;
    this.wanderR = opts.wanderR || 16;
    this.region = opts.region || null;    // lot to stay in (parks / plazas)
    this.goalX = pos.x; this.goalZ = pos.z; this.hasGoal = false;
    // ---- behaviour
    this.state = 'idle';
    this.stateT = 0;
    this.idleT = rand(1, 4);
    this.idleKind = 'look';
    this.partner = null;
    this.chatCd = rand(5, 15);
    this.thinkT = Math.random() * 0.15;
    this.threatX = 0; this.threatZ = 0; this.threat = null; this.fleeT = 0; this.fleeDirX = 0; this.fleeDirZ = 0;
    this.target = null; this.attackT = 0; this.punchCd = 0; this.fightT = 0;
    this.hostile = false; this.hostileT = 0; this.lostT = 0; this.lastSeenX = 0; this.lastSeenZ = 0; this.los = false;
    this.strafe = 1; this.strafeT = 0; this.keepMin = rand(8, 9.5); this.keepMax = rand(12.5, 15);
    this.fireCd = rand(0.4, 1); this.burst = 3; this.mag = 12; this.reloadT = 0; this.aimT = 0;
    this.knockT = 0; this.diveCd = 0; this.dodgeCd = 0;
    this.deadT = 0;
    this.aimedT = 0;
    this.hurtSndCd = 0;
    this.homeVehicle = opts.homeVehicle || null;
    this.lookAtPlayer = 0;
    this.gesture = 0;
    this.removed = false;
    this.spawnT = this.game.time;
    this.flinchT = 0;
    this.startle = 0;
    this.sitBlend = 0;
    this.cowerT = 0;
    this.afterKnock = null;
    this.targetDist = 0;

    // initial behaviour
    if (this.mode === 'walk' && !this.attachToGraph(opts.edge || null, opts.edgeT)) this.mode = opts.mode === 'guard' ? 'guard' : 'wander';
    const mood = opts.mood || 'calm';
    const tgt = opts.target && opts.target.position ? opts.target : null;
    if (tgt) { this.threat = tgt; this.threatX = tgt.position.x; this.threatZ = tgt.position.z; }
    else { this.threatX = pos.x - Math.sin(this.yaw) * 3; this.threatZ = pos.z - Math.cos(this.yaw) * 3; }
    if (mood === 'fight') this.target = tgt || this.game.player;
    if (opts.knocked) { this.state = 'knocked'; this.knockT = rand(0.7, 1.2); this.afterKnock = mood; }
    else if (mood === 'flee') this.startFlee(this.threatX, this.threatZ, tgt);
    else if (mood === 'fight') this.startFight(this.target);
    else if (this.mode === 'walk') this.setState(chance(0.25) ? 'idle' : 'walk');
    else this.setState('idle');
    this.humanoid.root.position.copy(this.position);
    this.humanoid.root.rotation.y = this.yaw;
  }

  // ============================================================================================ entity API

  /** World AABB: standing box, or a flat box along the body when lying dead. */
  getBox(out) {
    const p = this.position;
    if (this.alive && this.state !== 'knocked') {
      out.min.set(p.x - this.radius, p.y, p.z - this.radius);
      out.max.set(p.x + this.radius, p.y + this.height, p.z + this.radius);
      return out;
    }
    // falls backwards: body from the feet to ~1.8 m behind
    const bx = p.x - Math.sin(this.yaw) * 1.7 * this.scale, bz = p.z - Math.cos(this.yaw) * 1.7 * this.scale;
    out.min.set(Math.min(p.x, bx) - 0.35, p.y, Math.min(p.z, bz) - 0.35);
    out.max.set(Math.max(p.x, bx) + 0.35, p.y + 0.5, Math.max(p.z, bz) + 0.35);
    return out;
  }

  /** Damage (bullets, punches, cars, explosions...). Emits entityDamaged / entityKilled. */
  damage(amount, info = {}) {
    amount = Number(amount);
    if (!(amount > 0) || this.removed) return;
    info = info || {};
    const g = this.game;
    const chest = _v.set(this.position.x, this.position.y + 1.25 * this.scale, this.position.z);
    if (!this.alive) {
      if (info.type === 'bullet' || info.type === 'melee') { try { g.fx?.blood?.(info.point || chest, info.dir || _d.set(0, 1, 0)); } catch (e) { /* fx */ } }
      return;
    }
    this.health -= amount;
    this.humanoid.flash();
    try { g.fx?.blood?.(info.point || chest, info.dir || _d.set(Math.random() - 0.5, 0.6, Math.random() - 0.5)); } catch (e) { /* fx stub */ }
    // flinch: a small shove + lean away from the hit
    if (info.dir && info.type !== 'vehicle') {
      const k = info.type === 'melee' ? 2.4 : 1.2;
      this.velocity.x += info.dir.x * k; this.velocity.z += info.dir.z * k;
    }
    this.flinchT = 0.25;
    g.events.emit('entityDamaged', { entity: this, amount, info });
    if (this.health <= 0) { this.die(info); return; }
    if (this.hurtSndCd <= 0) {
      this.hurtSndCd = 0.6;
      g.audio?.play?.('hurt', { position: this.position, volume: 0.45, pitch: rand(1.15, 1.45) });
    }
    this.sys.onPedHurt(this, info);
  }

  /** Physical push (velocity change, m/s): car hits, explosions. Big pushes knock the ped over. */
  knockback(impulse) {
    if (!impulse || this.removed) return;
    this.velocity.add(impulse);
    const h = Math.hypot(this.velocity.x, this.velocity.z);
    if (h > 20) { this.velocity.x *= 20 / h; this.velocity.z *= 20 / h; }
    this.velocity.y = clamp(this.velocity.y, -30, 13);
    if (this.velocity.y > 0.5) this.onGround = false;
    const mag = Math.hypot(impulse.x, impulse.y || 0, impulse.z);
    if (this.alive && mag > 4.5 && this.state !== 'dead') {
      if (this.state !== 'knocked') this.afterKnock = this.state === 'shoot' || this.state === 'fight' ? this.state : 'flee';
      this.setState('knocked');
      this.knockT = rand(1.3, 2.3);
      // face against the push so the backwards fall follows it
      this.yaw = Math.atan2(-impulse.x, -impulse.z);
      this.partner = null;
    }
  }

  die(info) {
    const g = this.game;
    this.alive = false;
    this.health = 0;
    this.setState('dead');
    this.deadT = 0;
    this.partner = null;
    this.height = 0.5;
    if (this.weapon) this.humanoid.setHeld(null);
    g.events.emit('entityKilled', { entity: this, info });
    g.audio?.play?.('death', { position: this.position, volume: 0.9, pitch: rand(0.9, 1.15) });
    try {
      const c = _v.set(this.position.x, this.position.y + 1, this.position.z);
      g.fx?.blood?.(c, _d.set(0, 1, 0));
      g.fx?.blood?.(c, _d.set(Math.random() - 0.5, 0.4, Math.random() - 0.5));
    } catch (e) { /* fx stub */ }
    this.sys.onPedDeath(this, info);
  }

  // ============================================================================================ states

  setState(s) {
    if (this.state === 'chat' && s !== 'chat' && this.partner) {
      const p = this.partner;
      this.partner = null;
      if (p.partner === this) { p.partner = null; if (p.state === 'chat') p.setState('idle'); p.idleT = rand(0.5, 2); }
    }
    this.state = s;
    this.stateT = 0;
  }

  /** Run away from (x, z) (threat: optional entity followed while fleeing). startle: seconds frozen in fright first. */
  startFlee(x, z, threat = null, dur = rand(8, 12), startle = 0) {
    if (!this.alive || this.state === 'knocked' || this.state === 'dive') { this.afterKnock = 'flee'; this.threatX = x; this.threatZ = z; return; }
    if (this.state !== 'flee') {
      this.setState('flee');
      this.fleeDirX = 0; this.fleeDirZ = 0;
      this.thinkT = 0;
      this.startle = startle;
    }
    this.threatX = x; this.threatZ = z; this.threat = threat;
    this.fleeT = Math.max(this.fleeT, dur);
  }

  startFight(target) {
    if (!this.alive || !target) return;
    if (this.weapon) { this.startShoot(target); return; }
    this.target = target;
    this.fightT = 0;
    this.punchCd = rand(0.3, 0.7);
    if (this.state === 'knocked' || this.state === 'dive') { this.afterKnock = 'fight'; return; }
    this.setState('fight');
  }

  startShoot(target) {
    if (!this.alive || !target) return;
    if (this.state !== 'shoot' || this.target !== target) this.hostileT = 0; // aim warm-up only for a new fight
    this.target = target;
    this.hostile = true;
    this.lostT = 0;
    this.lastSeenX = target.position.x; this.lastSeenZ = target.position.z;
    if (this.state === 'knocked' || this.state === 'dive') { this.afterKnock = 'shoot'; return; }
    if (this.state !== 'shoot') { this.setState('shoot'); this.aimT = rand(0.25, 0.6); }
  }

  startCower(x, z) {
    if (!CALM.has(this.state)) return;
    this.threatX = x; this.threatZ = z;
    this.setState('cower');
    this.cowerT = rand(1.8, 3.5);
  }

  /** Back to normal life after a scare: rejoin the sidewalk network (or wander where we are). */
  calmDown() {
    this.threat = null;
    this.target = null;
    this.hostile = false;
    if (this.homeVehicle && this.sys.canReturnTo(this, this.homeVehicle)) { this.setState('return'); return; }
    if (this.mode === 'guard') { this.setState('idle'); this.idleT = rand(2, 5); return; }
    if (this.mode === 'walk' || this.sys.nav) {
      if (this.attachToGraph(null)) { this.mode = 'walk'; this.setState('walk'); return; }
    }
    this.mode = 'wander';
    this.anchorX = this.position.x; this.anchorZ = this.position.z;
    this.hasGoal = false;
    this.setState('idle');
    this.idleT = rand(1, 3);
  }

  // ============================================================================================ sidewalk graph

  /** Attach to an edge (or the nearest one within 14 m). Picks the direction leading away from any threat. */
  attachToGraph(edge = null, t = null) {
    const walk = this.sys.nav && this.sys.nav.walk;
    if (!walk) return false;
    let e = edge, et = t;
    if (!e) {
      const ne = nearestWalkEdge(walk, this.position.x, this.position.z, 14, _ne);
      if (!ne) return false;
      e = ne.edge; et = ne.t;
    }
    this.edge = e;
    let fwd = chance(0.5);
    if (this.threat || this.state === 'flee') {
      fwd = (e.dx * (this.position.x - this.threatX) + e.dz * (this.position.z - this.threatZ)) > 0;
    } else {
      // prefer the direction we are facing
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      fwd = e.dx * fx + e.dz * fz >= 0;
    }
    this.fwd = fwd;
    const tt = et === null || et === undefined ? (this.position.x - e.ax) * e.dx + (this.position.z - e.az) * e.dz : et;
    this.es = fwd ? tt : e.len - tt;
    this.pendingEdge = null;
    return true;
  }

  /** Choose the next edge at the vertex we just reached. */
  onVertex() {
    const e = this.edge;
    const v = this.fwd ? e.b : e.a;
    const opts = v.edges;
    let best = null;
    if (opts.length === 1) best = opts[0];
    else {
      let total = 0;
      for (const o of opts) if (o !== e) total += o.kind === 'cross' ? 0.6 : 1;
      let r = Math.random() * total;
      for (const o of opts) {
        if (o === e) continue;
        r -= o.kind === 'cross' ? 0.6 : 1;
        if (r <= 0) { best = o; break; }
      }
      if (!best) best = opts[0] === e ? opts[1] : opts[0];
    }
    this.enterEdge(best, v);
  }

  enterEdge(edge, fromVertex) {
    if (edge.kind === 'cross' && !crossSafe(this, edge)) {
      this.pendingEdge = edge;
      this.pendingFrom = fromVertex;
      this.setState('wait');
      return;
    }
    this.edge = edge;
    this.fwd = edge.a === fromVertex;
    this.es = 0;
    this.pendingEdge = null;
    if (this.state === 'wait') this.setState('walk');
  }

  /** Point on the current edge at distance `s` from the traversal start, with the sidewalk lateral offset. */
  edgePoint(s, out) {
    const e = this.edge;
    const L = e.len;
    s = s < 0 ? 0 : s > L ? L : s;
    const t = this.fwd ? s : L - s;
    const lat = e.kind === 'cross' ? this.crossLat : this.lat;
    out.x = e.ax + e.dx * t + e.nx * lat;
    out.z = e.az + e.dz * t + e.nz * lat;
    return out;
  }

  // ============================================================================================ update

  /** Per-frame update. d2: squared distance to the player; near: within the full-simulation radius. */
  update(dt, d2, near) {
    const g = this.game;
    this.stateT += dt;
    if (this.hurtSndCd > 0) this.hurtSndCd -= dt;
    if (this.flinchT > 0) this.flinchT -= dt;
    if (this.dodgeCd > 0) this.dodgeCd -= dt;
    if (this.chatCd > 0) this.chatCd -= dt;
    if (this.state === 'dead') {
      this.deadT += dt;
      this.dvx = 0; this.dvz = 0;
      if (near && (this.deadT < 4 || !this.onGround)) this.move(dt, true, 6);
      if (near) this.animate(dt, d2);
      return;
    }
    // think (perception / decisions) at a reduced rate, lower when far
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = near ? rand(0.1, 0.14) : rand(0.3, 0.45);
      this.think(near);
      if (this.removed) return;
    }
    this.steer(dt);
    if (this.state === 'shoot' || this.state === 'fight') updateWeapon(this, dt);
    this.move(dt, near, this.state === 'flee' || this.state === 'fight' || this.state === 'shoot' || this.state === 'return' ? 16 : 8);
    if (near) this.animate(dt, d2);
  }

  think(near) {
    const st = this.state;
    if (near && st !== 'knocked' && st !== 'dive' && this.dodgeCd <= 0) { if (checkDodge(this)) return; }
    switch (st) {
      case 'walk': this.thinkWalk(); break;
      case 'idle': case 'chat':
        this.idleT -= this.thinkDtGuess();
        if (st === 'chat' && (!this.partner || !this.partner.alive || this.partner.state !== 'chat')) { this.setState('idle'); this.idleT = rand(0.5, 2); }
        if (this.idleT <= 0) {
          if (this.mode === 'guard') { this.idleT = rand(3, 7); this.targetYaw = this.yaw + rand(-1.2, 1.2); }
          else this.setState('walk');
        }
        break;
      case 'wait': {
        if (!this.pendingEdge) { this.setState('walk'); break; }
        if (crossSafe(this, this.pendingEdge)) this.enterEdge(this.pendingEdge, this.pendingFrom);
        else if (this.stateT > 8) {
          // give up crossing here: walk on along another sidewalk
          const v = this.pendingFrom;
          const alt = v.edges.filter((o) => o.kind !== 'cross' && o !== this.pendingEdge);
          const pick = alt.length ? alt[Math.floor(Math.random() * alt.length)] : null;
          this.pendingEdge = null;
          if (pick) { this.edge = pick; this.fwd = pick.a === v; this.es = 0; }
          this.setState('walk');
        }
        break;
      }
      case 'flee': thinkFlee(this); break;
      case 'cower':
        this.cowerT -= this.thinkDtGuess();
        if (this.cowerT <= 0) this.startFlee(this.threatX, this.threatZ, this.threat, rand(6, 10));
        break;
      case 'fight': thinkFight(this); break;
      case 'shoot': thinkShoot(this); break;
      case 'knocked':
        this.knockT -= this.thinkDtGuess();
        if (this.knockT <= 0 && this.onGround) {
          const next = this.afterKnock || 'flee';
          this.afterKnock = null;
          this.setState('idle');
          if (next === 'fight' && this.target) this.startFight(this.target);
          else if (next === 'shoot' && this.target) this.startShoot(this.target);
          else if (next === 'calm') this.calmDown();
          else this.startFlee(this.threatX, this.threatZ, this.threat, rand(6, 10));
        }
        break;
      case 'dive':
        if (this.stateT > 0.25 && this.onGround) { this.setState('knocked'); this.knockT = rand(0.5, 0.9); this.afterKnock = 'flee'; }
        break;
      case 'return': {
        const v = this.homeVehicle;
        if (!this.sys.canReturnTo(this, v)) { this.homeVehicle = null; this.calmDown(); break; }
        const door = v.getDoorPosition ? v.getDoorPosition(_v, 1, 0.5) : _v.copy(v.position);
        const dx = door.x - this.position.x, dz = door.z - this.position.z;
        if (dx * dx + dz * dz < 1.3 * 1.3 || this.stateT > 25) this.sys.reboard(this, v);
        break;
      }
      default: break;
    }
  }

  thinkDtGuess() { return this.thinkT > 0 ? Math.max(0.1, this.thinkT) : 0.12; }

  thinkWalk() {
    if (this.mode === 'walk') {
      // occasional stops: look around, phone, chat with someone passing by
      if (this.stateT > 4 && chance(0.012)) {
        this.setState('idle');
        this.idleT = rand(2.5, 7);
        this.idleKind = chance(0.35) ? 'phone' : 'look';
        return;
      }
      if (this.chatCd <= 0 && chance(0.25)) {
        this.chatCd = rand(10, 25);
        const o = this.sys.findChatPartner(this);
        if (o) this.sys.startChat(this, o);
      }
      if (this.bumpT > 1.2) {
        // something in the way (lamp post, parked car, other ped): turn around
        this.bumpT = 0;
        this.fwd = !this.fwd;
        this.es = this.edge.len - this.es;
      }
      return;
    }
    // wander / guard
    if (!this.hasGoal || this.bumpT > 1.5) {
      this.bumpT = 0;
      if (!this.sys.pickWanderGoal(this)) { this.setState('idle'); this.idleT = rand(1, 3); }
    }
  }

  /** Desired velocity for this frame. */
  steer(dt) {
    let speed = 0, dx = 0, dz = 0;
    switch (this.state) {
      case 'walk': {
        if (this.mode === 'walk' && this.edge) {
          const e = this.edge;
          // progress along the edge
          const t = (this.position.x - e.ax) * e.dx + (this.position.z - e.az) * e.dz;
          this.es = this.fwd ? t : e.len - t;
          if (this.es >= e.len - 0.35) { this.onVertex(); if (this.state !== 'walk') break; }
          this.edgePoint(this.es + 1.3, _v);
          dx = _v.x - this.position.x; dz = _v.z - this.position.z;
          speed = this.walkSpeed * (this.edge.kind === 'cross' ? 1.25 : 1);
        } else if (this.hasGoal) {
          dx = this.goalX - this.position.x; dz = this.goalZ - this.position.z;
          if (dx * dx + dz * dz < 0.7) {
            this.hasGoal = false;
            this.setState('idle');
            // strollers / beach-goers sometimes sit down on the grass or sand for a while
            const sit = this.sys.canSitHere(this) && chance(0.35);
            this.idleKind = sit ? 'sit' : chance(0.25) ? 'phone' : 'look';
            this.idleT = sit ? rand(8, 20) : rand(2, 7);
            break;
          }
          speed = this.walkSpeed;
        }
        break;
      }
      case 'flee': ({ dx, dz, speed } = steerFlee(this)); break;
      case 'fight': ({ dx, dz, speed } = steerFight(this)); break;
      case 'shoot': ({ dx, dz, speed } = steerShoot(this, dt)); break;
      case 'return': {
        const v = this.homeVehicle;
        if (v && !v.removed) {
          const door = v.getDoorPosition ? v.getDoorPosition(_v, 1, 0.5) : _v.copy(v.position);
          dx = door.x - this.position.x; dz = door.z - this.position.z;
          speed = this.walkSpeed * 1.3;
        }
        break;
      }
      case 'idle': case 'chat': case 'wait': case 'cower':
        break;
      default: break;
    }
    const l = Math.hypot(dx, dz);
    if (l > 1e-4 && speed > 0) {
      this.dvx = (dx / l) * speed; this.dvz = (dz / l) * speed;
      if (this.state !== 'shoot' && this.state !== 'fight') this.targetYaw = Math.atan2(dx, dz);
    } else { this.dvx = 0; this.dvz = 0; }
    // facing for stationary states
    if (this.state === 'cower') this.targetYaw = Math.atan2(this.threatX - this.position.x, this.threatZ - this.position.z);
    else if (this.state === 'chat' && this.partner) this.targetYaw = Math.atan2(this.partner.position.x - this.position.x, this.partner.position.z - this.position.z);
    else if (this.state === 'wait' && this.pendingEdge) {
      const pe = this.pendingEdge, fwd = pe.a === this.pendingFrom;
      this.targetYaw = Math.atan2(fwd ? pe.dx : -pe.dx, fwd ? pe.dz : -pe.dz);
    } else if (this.state === 'idle' && this.idleKind === 'look' && this.stateT > 1.5 && Math.random() < dt * 0.4) {
      this.targetYaw = this.yaw + rand(-1.4, 1.4);
    }
  }

  /** Integrate velocity, gravity, voxel collisions (near) or cheap kinematics (far). */
  move(dt, near, accel) {
    const g = this.game, vel = this.velocity, pos = this.position;
    const grounded = this.onGround && this.state !== 'knocked' && this.state !== 'dive' && this.state !== 'dead';
    if (grounded) {
      const k = Math.min(1, accel * dt / Math.max(0.5, Math.hypot(this.dvx - vel.x, this.dvz - vel.z)));
      vel.x += (this.dvx - vel.x) * k;
      vel.z += (this.dvz - vel.z) * k;
    } else if (this.onGround) {
      // lying / sliding on the ground: friction
      const f = Math.exp(-6 * dt);
      vel.x *= f; vel.z *= f;
    }
    // turn toward the facing target
    if (this.state !== 'dead' && this.state !== 'knocked') {
      const rate = this.state === 'flee' || this.state === 'shoot' || this.state === 'fight' ? 12 : 7;
      const da = angleDiff(this.yaw, this.targetYaw);
      this.yaw = wrapAngle(this.yaw + clamp(da, -rate * dt, rate * dt));
    }
    if (near) {
      vel.y -= (this.inWater ? PHYS.WATER_GRAVITY : PHYS.GRAVITY) * dt;
      if (vel.y < -PHYS.TERMINAL_VELOCITY) vel.y = -PHYS.TERMINAL_VELOCITY;
      if (this.inWater) { vel.y = Math.max(vel.y, -2); if (this.state !== 'dead') vel.y += 6 * dt; }
      const w = g.world;
      const h = this.alive ? this.height : 0.5;
      const wantX = vel.x, wantZ = vel.z;
      moveBox(w, pos, this.radius, h, vel, dt, this.alive && this.state !== 'knocked' ? STEP1 : STEP0, _out);
      this.onGround = _out.onGround;
      this.inWater = _out.inWater;
      if (_out.stepped > 0) this.stepOffset = Math.min(1, this.stepOffset + _out.stepped);
      const blocked = (_out.hitX && Math.abs(wantX) > 0.3) || (_out.hitZ && Math.abs(wantZ) > 0.3);
      if (blocked && this.hspeed < 0.3) this.bumpT += dt; else this.bumpT = Math.max(0, this.bumpT - dt * 0.5);
    } else {
      // far away: no voxel physics (the chunk may not even be generated) - glide along the surface
      vel.y = 0;
      pos.x += vel.x * dt; pos.z += vel.z * dt;
      const plan = g.generator && g.generator.plan;
      if (plan && plan.surfaceY) {
        const sy = plan.surfaceY(pos.x, pos.z);
        if (Number.isFinite(sy) && Math.abs(sy - pos.y) < 3) pos.y = sy;
      }
      this.onGround = true;
      this.inWater = false;
    }
    if (this.inWater) this.waterT += dt; else this.waterT = 0;
    if (this.stepOffset > 0) this.stepOffset = Math.max(0, this.stepOffset - dt * 6);
    this.hspeed = Math.hypot(vel.x, vel.z);
    // keep out of vehicles (parked cars do not push us themselves)
    if (near && this.alive) this.sys.pushOutOfVehicles(this);
  }

  /** Model placement + procedural animation (+ small touches: phone, chat gestures, glance at the player). */
  animate(dt, d2) {
    const h = this.humanoid, g = this.game;
    h.root.position.set(this.position.x, this.position.y - this.stepOffset, this.position.z);
    h.root.rotation.y = this.yaw;
    let state = 'normal';
    const st = this.state;
    const sitting = st === 'idle' && this.idleKind === 'sit';
    this.sitBlend += ((sitting ? 1 : 0) - this.sitBlend) * Math.min(1, dt * 5);
    if (sitting) state = 'sit';
    if (this.sitBlend > 0.01) h.root.position.y -= 0.62 * this.scale * this.sitBlend; // on the ground, not a chair
    if (st === 'dead' || st === 'knocked') state = 'dead';
    else if (st === 'dive') state = 'air';
    else if (st === 'cower') state = 'hands_up';
    else if (this.inWater && !this.onGround) state = 'swim';
    else if (!this.onGround && this.velocity.y < -3) state = 'air';
    // fleeing from gunfire: hands over the head for the first moments
    if (st === 'flee' && this.stateT < (this.startle || 0)) state = 'hands_up';
    const aiming = st === 'shoot' && !!this.weapon && this.reloadT <= 0;
    let aimPitch = 0;
    if (aiming && this.target) {
      const tp = this.target.position;
      const dy = tp.y + 1.2 - (this.position.y + 1.45);
      aimPitch = Math.atan2(dy, Math.max(1, Math.hypot(tp.x - this.position.x, tp.z - this.position.z)));
    }
    h.animate(dt, { speed: this.hspeed, aiming, aimPitch, state, twoHanded: false, crouch: st === 'cower' && this.stateT < 0.3 });
    if (state !== 'normal') { h.head.rotation.y *= 0.8; return; }
    // after-animate overrides (the humanoid eases back to its own pose when these stop)
    if (st === 'idle' && this.idleKind === 'phone') {
      h.armR.rotation.x = -2.5; h.armR.rotation.z = -0.35; h.head.rotation.x = 0.18;
    } else if (st === 'chat') {
      this.gesture += dt * rand(3, 5);
      h.armR.rotation.x = -0.7 + Math.sin(this.gesture) * 0.45;
      h.armL.rotation.x = -0.3 + Math.sin(this.gesture * 0.7 + 1) * 0.3;
      h.head.rotation.x = Math.sin(this.gesture * 1.3) * 0.08;
    } else if (st === 'fight' && this.stateT < 0.6 && this.target === g.player) {
      // squaring up
      h.armL.rotation.x = -1.2; h.armR.rotation.x = -1.0;
    } else if (st === 'return' && this.homeVehicle && this.stateT < 1.2) {
      h.armR.rotation.x = -2.6; // shaking a fist
    }
    // glance at the player when they walk close
    let headYaw = 0;
    const p = g.player;
    if (p && d2 < 25 && p.alive !== false && !p.hidden && CALM.has(st)) {
      const a = angleDiff(this.yaw, Math.atan2(p.position.x - this.position.x, p.position.z - this.position.z));
      if (Math.abs(a) < 1.7) headYaw = clamp(a, -1.0, 1.0);
    }
    h.head.rotation.y += (headYaw - h.head.rotation.y) * Math.min(1, dt * 5);
  }

  /** Remove the model (called by Peds on despawn). */
  dispose() {
    this.removed = true;
    this.partner = null;
    this.humanoid.dispose();
  }
}
