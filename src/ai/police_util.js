// Police helpers (POLICE agent): allocation-free line of sight through the voxel world, aiming with a chosen
// hit/miss outcome, small random helpers and view tests. No DOM access at module level (Node-importable).
import * as THREE from 'three';
import { BLOCKS } from '../world/blocks.js';
import { WORLD } from '../core/config.js';

/** Blocks that stop a cop's eye-line: solid, not see-through (glass is transparent, leaves/hedges hide you). */
export const SIGHT_BLOCKER = new Uint8Array(256);
/** Blocks a car cannot drive through (anything solid, glass included). */
export const SOLID_BLOCKER = new Uint8Array(256);
for (const d of BLOCKS) {
  if (!d) continue;
  SIGHT_BLOCKER[d.id] = d.solid && !d.transparent && !d.liquid ? 1 : 0;
  SOLID_BLOCKER[d.id] = d.solid ? 1 : 0;
}

export const rand = (lo = 0, hi = 1) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));
export const chance = (p) => Math.random() < p;

/**
 * True if no blocking voxel (per `mask`, default: sight blockers) lies on the segment a -> b (the cells of both
 * endpoints are not tested, so an eye or a target touching a wall still counts). Allocation-free 3D DDA.
 */
export function losClear(world, ax, ay, az, bx, by, bz, mask = SIGHT_BLOCKER) {
  if (!world || typeof world.getBlock !== 'function') return true;
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return true;
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ax), y = Math.floor(ay), z = Math.floor(az);
  const ex = Math.floor(bx), ey = Math.floor(by), ez = Math.floor(bz);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = sz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = sx > 0 ? (x + 1 - ax) * tdx : sx < 0 ? (ax - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - ay) * tdy : sy < 0 ? (ay - y) * tdy : Infinity;
  let tmz = sz > 0 ? (z + 1 - az) * tdz : sz < 0 ? (az - z) * tdz : Infinity;
  const H = WORLD.HEIGHT;
  // never force synchronous chunk generation just to look: unknown (not yet generated) terrain counts as clear
  const chunks = world.chunks instanceof Map ? world.chunks : null;
  let ccx = NaN, ccz = NaN;
  for (let i = 0; i < 1024; i++) {
    let t;
    if (tmx < tmy) {
      if (tmx < tmz) { x += sx; t = tmx; tmx += tdx; } else { z += sz; t = tmz; tmz += tdz; }
    } else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; } else { z += sz; t = tmz; tmz += tdz; }
    if (t >= len) return true;
    if (x === ex && y === ey && z === ez) return true;
    if (y < 0) return false;
    if (y >= H) continue;
    if (chunks) {
      const cx = x >> 4, cz = z >> 4;
      if (cx !== ccx || cz !== ccz) {
        ccx = cx; ccz = cz;
        if (x >= 0 && z >= 0 && x < WORLD.SIZE_X && z < WORLD.SIZE_Z && !chunks.has(cx + ',' + cz)) return true;
      }
    }
    if (mask[world.getBlock(x, y, z)]) return false;
  }
  return true;
}

/** Horizontal distance. */
export const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Horizontal speed of an entity / vehicle (m/s). */
export function speedOf(e) {
  if (!e || !e.velocity) return 0;
  return Math.hypot(e.velocity.x, e.velocity.z);
}

/** Point the police aim at / look at on the player (the vehicle centre when driving). Writes out. */
export function playerAimPoint(player, out) {
  const v = player && player.inVehicle;
  if (v && v.position) {
    const h = (v.def && v.def.size && v.def.size.h) || 1.5;
    return out.set(v.position.x, v.position.y + h * 0.55, v.position.z);
  }
  const p = player.position;
  return out.set(p.x, p.y + (player.crouching ? 0.95 : 1.3), p.z);
}

const _perp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3();

/**
 * Direction from origin to the player for one shot. hit=true aims at a random point on the body (or vehicle),
 * hit=false aims at a convincing near-miss 0.9-2.2 m beside the target (bullets whiz past and hit the scenery).
 * Writes the unit direction into out and returns it.
 */
export function aimShot(origin, player, hit, out) {
  const v = player.inVehicle;
  if (v && v.position) {
    const d = v.def && v.def.size ? v.def.size : { w: 2, h: 1.5, l: 4.4 };
    _aim.set(v.position.x + rand(-0.4, 0.4) * d.w * 0.5, v.position.y + d.h * rand(0.35, 0.75), v.position.z + rand(-0.4, 0.4) * d.w * 0.5);
  } else {
    const p = player.position;
    // body, not the head: cops are not snipers (headshots double damage)
    _aim.set(p.x + rand(-0.12, 0.12), p.y + (player.crouching ? rand(0.55, 0.95) : rand(0.8, 1.3)), p.z + rand(-0.12, 0.12));
  }
  out.subVectors(_aim, origin);
  if (!hit) {
    const len = out.length() || 1;
    _perp.crossVectors(out, _up);
    if (_perp.lengthSq() < 1e-6) _perp.set(1, 0, 0);
    _perp.normalize();
    const side = Math.random() < 0.5 ? -1 : 1;
    // clear the target's silhouette: a car is ~5 m long, a person ~0.6 m wide
    const half = v && v.def && v.def.size ? Math.max(v.def.size.w, v.def.size.l) * 0.5 + 0.4 : 0.5;
    const off = half + rand(0.5, 1.7);
    _aim.addScaledVector(_perp, side * off);
    _aim.y += v ? rand(0.6, 1.6) : rand(-0.6, 0.9);
    out.subVectors(_aim, origin);
    // keep a slight lead past the target so misses continue behind it
    out.multiplyScalar(1 + 6 / len);
  }
  return out.normalize();
}

const _cd = new THREE.Vector3();
/**
 * Is a world point roughly visible from the camera? Inside a ~70-degree cone, within maxDist, and not hidden
 * behind blocks (a quick LOS test). Used to keep spawns and despawns out of sight.
 */
export function pointInView(game, x, y, z, maxDist = 160) {
  const cam = game && game.camera;
  if (!cam) return false;
  cam.getWorldDirection(_cd);
  const vx = x - cam.position.x, vy = y - cam.position.y, vz = z - cam.position.z;
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (d < 6) return true;
  if (d > maxDist) return false;
  if ((vx * _cd.x + vy * _cd.y + vz * _cd.z) / d < 0.45) return false;
  return losClear(game.world, cam.position.x, cam.position.y, cam.position.z, x, y, z);
}

/** Standing height at (x, z) scanning down from fromY (or the plan surface + a margin). -1 if none. */
export function groundAt(game, x, z, fromY) {
  const w = game.world;
  if (!w || typeof w.findGround !== 'function') return WORLD.CITY_LEVEL;
  let start = fromY;
  if (!Number.isFinite(start)) {
    const plan = game.generator && game.generator.plan;
    const sy = plan && typeof plan.surfaceY === 'function' ? plan.surfaceY(x, z) : WORLD.CITY_LEVEL;
    start = (Number.isFinite(sy) ? sy : WORLD.CITY_LEVEL) + 3;
  }
  const y = w.findGround(x, z, Math.floor(start));
  return y > 0 ? y : -1;
}

/** Is (x, z) water according to the plan (or the voxel at sea level)? */
export function isWaterAt(game, x, z) {
  const plan = game.generator && game.generator.plan;
  if (plan && typeof plan.isWater === 'function') return !!plan.isWater(x, z);
  const w = game.world;
  if (!w || typeof w.getBlock !== 'function') return false;
  const id = w.getBlock(Math.floor(x), WORLD.SEA_LEVEL - 1, Math.floor(z));
  return !!(BLOCKS[id] && BLOCKS[id].liquid);
}

/** The player's currently selected item is a gun (cops at 2 stars only shoot armed suspects). */
export function playerArmed(game) {
  const inv = game.inventory;
  let it = null;
  try { it = inv && typeof inv.getSelected === 'function' ? inv.getSelected() : null; } catch (e) { it = null; }
  return !!(it && it.kind === 'weapon' && it.id !== 'bat' && it.id !== 'fist');
}
