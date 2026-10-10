// Pedestrian behaviours that need world / combat knowledge (NPC agent): fleeing with wall / water / cliff /
// traffic avoidance, melee fights, armed gang shootouts (keep 8-15 m, strafe, bursts, reloads, modest accuracy),
// diving away from speeding cars and crosswalk safety checks. Used by Ped (npc_ped.js).
import * as THREE from 'three';
import { boxCollides, hasLineOfSight } from '../core/physics.js';
import { angleDiff } from '../core/math.js';
import { rand, chance } from './npc_util.js';
import { aimShot } from './police_util.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muz = new THREE.Vector3();
const FLEE_ANGLES = [0, 0.55, -0.55, 1.15, -1.15, 1.9, -1.9];
const PROBES = [1.6, 4];
const _steer = { dx: 0, dz: 0, speed: 0 };

function plan(ped) { return ped.game.generator && ped.game.generator.plan; }

/** Position of whatever we are fighting / fleeing (the vehicle when the target is driving). */
function targetPos(t) {
  if (!t) return null;
  if (t.inVehicle && t.inVehicle.position) return t.inVehicle.position;
  return t.position || null;
}

// ================================================================================================ flee

/** Score a flee direction: away from the threat, clear of walls, water, cliffs and busy roads. */
function scoreDir(ped, dx, dz, ax, az, near) {
  let s = (dx * ax + dz * az) * 2;
  s += 0.6 * (dx * ped.fleeDirX + dz * ped.fleeDirZ); // keep going the same way (no dithering)
  if (!near) return s;
  const g = ped.game, w = g.world, p = ped.position, P = plan(ped);
  for (const r of PROBES) {
    const x = p.x + dx * r, z = p.z + dz * r;
    if (P && P.isWater(x, z)) { s -= 8; break; }
    // a wall we cannot step onto
    if (w && boxCollides(w, x, p.y + 1.02, z, 0.3, 1.7)) { s -= r < 2 ? 7 : 3; break; }
    if (w && P) {
      // cliff: no ground within 2.5 blocks below
      let drop = true;
      for (let k = 0; k <= 3; k++) if (w.isSolid(Math.floor(x), Math.floor(p.y) - 1 - k, Math.floor(z))) { drop = false; break; }
      if (drop) { s -= 6; break; }
    }
    if (P) {
      if (P.isSidewalk(x, z)) s += 0.35;
      else if (P.isRoad(x, z)) s -= 0.5 + (carNear(ped, x, z, 14) ? 2.5 : 0);
    }
  }
  return s;
}

function carNear(ped, x, z, r) {
  const list = ped.game.vehicles ? ped.game.vehicles.list : null;
  if (!list) return false;
  for (const o of list) {
    const dx = o.position.x - x, dz = o.position.z - z;
    if (dx * dx + dz * dz < r * r && Math.abs(o.speed || 0) > 1.5) return true;
  }
  return false;
}

export function thinkFlee(ped) {
  const dt = ped.thinkDtGuess();
  ped.fleeT -= dt;
  const tp = targetPos(ped.threat);
  if (tp && ped.threat.alive !== false) { ped.threatX = tp.x; ped.threatZ = tp.z; }
  const p = ped.position;
  let ax = p.x - ped.threatX, az = p.z - ped.threatZ;
  const dist = Math.hypot(ax, az);
  if (ped.fleeT <= 0) {
    if (dist > 20) { ped.calmDown(); return; }
    ped.fleeT = 1.5;
  }
  if (dist < 0.1) { const a = Math.random() * 6.283; ax = Math.sin(a); az = Math.cos(a); } else { ax /= dist; az /= dist; }
  const near = ped.thinkT < 0.2;
  let best = -1e9, bx = ax, bz = az;
  for (const da of FLEE_ANGLES) {
    const c = Math.cos(da), s = Math.sin(da);
    const dx = ax * c - az * s, dz = ax * s + az * c;
    const sc = scoreDir(ped, dx, dz, ax, az, near);
    if (sc > best) { best = sc; bx = dx; bz = dz; }
  }
  ped.fleeDirX = bx; ped.fleeDirZ = bz;
  // cornered and the attacker is right here: some fight back
  if (best < -4 && dist < 2.5 && ped.threat && ped.threat.alive !== false && chance(0.25)) ped.startFight(ped.threat);
}

export function steerFlee(ped) {
  _steer.dx = ped.fleeDirX; _steer.dz = ped.fleeDirZ;
  _steer.speed = ped.stateT < (ped.startle || 0) ? 0 : ped.runSpeed * (ped.health < ped.maxHealth * 0.3 ? 0.75 : 1);
  if (ped.fleeDirX === 0 && ped.fleeDirZ === 0) {
    _steer.dx = ped.position.x - ped.threatX; _steer.dz = ped.position.z - ped.threatZ;
  }
  return _steer;
}

// ================================================================================================ melee fight

export function thinkFight(ped) {
  const t = ped.target;
  ped.fightT += ped.thinkDtGuess();
  if (!t || t.alive === false || t.removed) {
    // won the fight (or the other guy vanished): walk away
    ped.target = null;
    ped.calmDown();
    return;
  }
  const tp = targetPos(t);
  const dist = Math.hypot(tp.x - ped.position.x, tp.z - ped.position.z);
  if (ped.fightT > 25 || dist > 32) { ped.calmDown(); return; }
  if (ped.health < ped.maxHealth * 0.25 && ped.team === 'civilian') { ped.startFlee(tp.x, tp.z, t); return; }
  // the target sped off in a car
  if (t.inVehicle && Math.abs(t.inVehicle.speed || 0) > 6 && dist > 8) {
    if (ped.homeVehicle) ped.calmDown();
    else ped.startFlee(tp.x, tp.z, t, rand(3, 5));
  }
}

export function steerFight(ped) {
  _steer.dx = 0; _steer.dz = 0; _steer.speed = 0;
  const t = ped.target;
  const tp = targetPos(t);
  if (!tp) return _steer;
  const dx = tp.x - ped.position.x, dz = tp.z - ped.position.z;
  const d = Math.hypot(dx, dz);
  ped.targetYaw = Math.atan2(dx, dz);
  // reach: a person ~1.2 m, a car's side ~ its half width
  const reach = t.inVehicle ? (t.inVehicle.def ? t.inVehicle.def.size.w / 2 + 0.8 : 1.8) : 1.15;
  if (d > reach) {
    _steer.dx = dx; _steer.dz = dz;
    _steer.speed = d > 6 ? 5.2 : d > 2.5 ? 3.6 : 2;
  }
  return _steer;
}

// ================================================================================================ armed (gang)

export function thinkShoot(ped) {
  const g = ped.game, t = ped.target;
  const dt = ped.thinkDtGuess();
  ped.hostileT += dt;
  if (!t || t.alive === false || t.removed) {
    ped.lostT += dt;
    ped.los = false;
    if (ped.lostT > 2) { ped.target = null; ped.calmDown(); }
    return;
  }
  const tp = targetPos(t);
  const p = ped.position;
  const dist = Math.hypot(tp.x - p.x, tp.z - p.z);
  _a.set(p.x, p.y + 1.5 * ped.scale, p.z);
  _b.set(tp.x, tp.y + (t.inVehicle ? 0.9 : 1.2), tp.z);
  ped.los = dist < 70 && (!g.world || hasLineOfSight(g.world, _a, _b));
  if (ped.los) { ped.lastSeenX = tp.x; ped.lastSeenZ = tp.z; ped.lostT = 0; }
  else ped.lostT += dt;
  ped.targetDist = dist;
  if (ped.lostT > 16 || dist > 80) { ped.calmDown(); return; }
  if (ped.health < ped.maxHealth * 0.2 && !ped.persistent && chance(0.08)) { ped.startFlee(tp.x, tp.z, t); return; }
  ped.strafeT -= dt;
  if (ped.strafeT <= 0 || ped.bumpT > 0.4) { ped.strafe = -ped.strafe; ped.strafeT = rand(1.3, 2.8); ped.bumpT = 0; }
}

export function steerShoot(ped) {
  _steer.dx = 0; _steer.dz = 0; _steer.speed = 0;
  const t = ped.target;
  const tp = targetPos(t);
  if (!tp) return _steer;
  const p = ped.position;
  const dx = tp.x - p.x, dz = tp.z - p.z;
  const d = Math.hypot(dx, dz) || 1;
  ped.targetYaw = Math.atan2(dx, dz);
  if (ped.mode === 'guard' && ped.persistent && d < 30) {
    // bodyguards hold their ground, side-stepping a little
    _steer.dx = -dz * ped.strafe; _steer.dz = dx * ped.strafe; _steer.speed = 0.9;
    return _steer;
  }
  if (!ped.los) {
    const lx = ped.lastSeenX - p.x, lz = ped.lastSeenZ - p.z;
    if (lx * lx + lz * lz > 9) { _steer.dx = lx; _steer.dz = lz; _steer.speed = 4.2; }
    return _steer;
  }
  if (d > ped.keepMax) { _steer.dx = dx; _steer.dz = dz; _steer.speed = d > 25 ? 5.2 : 3.8; }
  else if (d < ped.keepMin) { _steer.dx = -dx; _steer.dz = -dz; _steer.speed = 2.6; }
  else { _steer.dx = -dz * ped.strafe; _steer.dz = dx * ped.strafe; _steer.speed = 1.8; }
  return _steer;
}

/** Per-frame weapon handling: punches (fight) or aiming + firing bursts (shoot). */
export function updateWeapon(ped, dt) {
  const g = ped.game, t = ped.target;
  if (!t) return;
  const tp = targetPos(t);
  if (!tp) return;
  const p = ped.position;
  const dx = tp.x - p.x, dz = tp.z - p.z;
  const d = Math.hypot(dx, dz);
  const facing = Math.abs(angleDiff(ped.yaw, Math.atan2(dx, dz)));
  if (ped.state === 'fight') {
    ped.punchCd -= dt;
    const reach = t.inVehicle ? (t.inVehicle.def ? t.inVehicle.def.size.w / 2 + 1.1 : 2.1) : 1.6;
    if (d < reach && ped.punchCd <= 0 && facing < 0.6) {
      ped.punchCd = rand(0.75, 1.15);
      ped.humanoid.punch();
      _a.set(p.x, p.y + 1.3 * ped.scale, p.z);
      _dir.set(dx, (tp.y + (t.inVehicle ? 0.8 : 1.25)) - _a.y, dz).normalize();
      const dmg = ped.team === 'gang' ? 12 : ped.homeVehicle ? 9 : 7;
      try { g.combat?.melee?.(ped, _a, _dir, dmg, reach + 0.6); } catch (e) { /* combat stub */ }
    }
    return;
  }
  // ---- shoot
  if (!ped.weapon) return;
  if (ped.reloadT > 0) {
    ped.reloadT -= dt;
    if (ped.reloadT <= 0) { ped.mag = 12; ped.aimT = rand(0.2, 0.4); }
    return;
  }
  ped.aimT -= dt;
  ped.fireCd -= dt;
  if (!ped.los || ped.aimT > 0 || facing > 0.3 || ped.fireCd > 0) return;
  fireAt(ped, t, tp, d);
}

/**
 * Chance that one gang pistol shot at the player lands (before the shared governor in Peds.rollPlayerHit): close,
 * still targets are easier, the first shots of a fight go wild and mission gunmen are a little better shots.
 */
export function gangHitChance(dist, tSpeed, hostileT, persistent) {
  let p = Math.min(0.22, Math.max(0.06, 0.22 - 0.005 * dist - (tSpeed > 3 ? 0.06 : 0)));
  p /= 1 + Math.max(0, 1.0 - hostileT * 0.15);
  if (persistent) p *= 1.2;
  return p;
}

function fireAt(ped, t, tp, dist) {
  const g = ped.game, p = ped.position;
  const sy = Math.sin(ped.yaw), cy = Math.cos(ped.yaw);
  const sc = ped.scale;
  // right hand: model -X is the character's right; world right = (-cos, 0, sin)
  _muz.set(p.x + sy * 0.62 * sc - cy * 0.3 * sc, p.y + 1.38 * sc, p.z + cy * 0.62 * sc + sy * 0.3 * sc);
  const tv = t.inVehicle ? t.inVehicle.velocity : t.velocity;
  const tSpeed = tv ? Math.hypot(tv.x, tv.z) : 0;
  if (t === g.player && ped.sys && typeof ped.sys.rollPlayerHit === 'function') {
    // shots at the player: an explicit hit / miss decision through a shared governor (like the police), so a group
    // of gangsters cannot land a burst of hits in a fraction of a second. Misses whiz convincingly past.
    const hit = ped.sys.rollPlayerHit(gangHitChance(dist, tSpeed, ped.hostileT, ped.persistent));
    aimShot(_muz, t, hit, _dir);
  } else {
    _b.set(tp.x, tp.y + (t.inVehicle ? 0.8 : 1.15), tp.z);
    _dir.subVectors(_b, _muz).normalize();
    let spread = 0.06 + 0.003 * dist + (tSpeed > 3 ? 0.04 : 0) + (ped.hspeed > 1 ? 0.025 : 0);
    spread *= 1 + Math.max(0, 1.0 - ped.hostileT * 0.15); // the first shots of a fight go wild
    if (ped.persistent) spread *= 0.8;                      // mission gunmen are a bit better shots
    spread = Math.min(0.2, spread);
    _a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * spread);
    _dir.add(_a).normalize();
  }
  try { g.combat?.fire?.(ped, _muz, _dir, ped.weapon || 'pistol'); } catch (e) { console.warn('[peds] combat.fire', e); }
  ped.humanoid.armR.rotation.x -= 0.35; // recoil kick
  ped.mag--;
  ped.burst--;
  if (ped.burst > 0) ped.fireCd = rand(0.32, 0.55);
  else { ped.burst = 2 + Math.floor(Math.random() * 2); ped.fireCd = rand(1.3, 2.3); }
  if (ped.mag <= 0) {
    ped.reloadT = rand(1.5, 2.1);
    g.audio?.play?.('reload', { position: p, volume: 0.6 });
  }
}

// ================================================================================================ traffic awareness

/** A fast vehicle is about to hit us: dive sideways. Returns true when diving. */
export function checkDodge(ped) {
  const g = ped.game;
  const list = g.vehicles ? g.vehicles.list : null;
  if (!list || !ped.alive || !ped.onGround) return false;
  const p = ped.position;
  for (const o of list) {
    const vx = o.velocity.x, vz = o.velocity.z;
    const sp2 = vx * vx + vz * vz;
    if (sp2 < 36) continue;
    const rx = p.x - o.position.x, rz = p.z - o.position.z;
    if (rx * rx + rz * rz > 24 * 24 || Math.abs(p.y - o.position.y) > 2.5) continue;
    const t = (rx * vx + rz * vz) / sp2;
    if (t < 0.05 || t > 1.05) continue;
    const mx = rx - vx * t, mz = rz - vz * t;
    const hw = o.def ? o.def.size.w / 2 : 1;
    if (mx * mx + mz * mz > (hw + 0.9) * (hw + 0.9)) continue;
    // reaction time: not everyone makes it
    if (chance(ped.state === 'flee' ? 0.15 : 0.25)) { ped.dodgeCd = 0.8; return false; }
    const sp = Math.sqrt(sp2);
    let nx = -vz / sp, nz = vx / sp;
    let side = Math.sign(mx * nx + mz * nz);
    if (!side) side = chance(0.5) ? 1 : -1;
    nx *= side; nz *= side;
    ped.velocity.set(nx * 6.5 + vx * 0.05, 4.8, nz * 6.5 + vz * 0.05);
    ped.onGround = false;
    ped.yaw = ped.targetYaw = Math.atan2(nx, nz);
    ped.threatX = o.position.x; ped.threatZ = o.position.z;
    ped.threat = o.driver === 'player' && g.player ? g.player : null;
    ped.afterKnock = 'flee';
    ped.setState('dive');
    ped.dodgeCd = 1.5;
    ped.sys.stats.dodges++;
    g.audio?.play?.('jump', { position: p, volume: 0.35, pitch: 1.2 });
    return true;
  }
  return false;
}

/** Is it safe to step onto this crosswalk now? (no moving car on it or approaching it) */
export function crossSafe(ped, edge) {
  const g = ped.game;
  const list = g.vehicles ? g.vehicles.list : null;
  if (!list) return true;
  const mx = (edge.ax + edge.bx) / 2, mz = (edge.az + edge.bz) / 2;
  for (const o of list) {
    if (o.isHeli && !o.onGround) continue;
    const rx = mx - o.position.x, rz = mz - o.position.z;
    const d2 = rx * rx + rz * rz;
    if (d2 > 45 * 45) continue;
    const vx = o.velocity.x, vz = o.velocity.z;
    const sp = Math.hypot(vx, vz);
    // distance from the car to the crossing segment
    let t = (o.position.x - edge.ax) * edge.dx + (o.position.z - edge.az) * edge.dz;
    t = t < 0 ? 0 : t > edge.len ? edge.len : t;
    const qx = edge.ax + edge.dx * t - o.position.x, qz = edge.az + edge.dz * t - o.position.z;
    const seg = Math.hypot(qx, qz);
    const hl = o.def ? o.def.size.l / 2 : 2.3;
    if (seg < hl + 1.4 && sp > 0.4) return false;
    if (sp < 1.2) continue; // waiting at the stop line
    const closing = (rx * vx + rz * vz) / sp;
    if (closing > 0 && seg < 6 + sp * 2.6) return false;
  }
  return true;
}
