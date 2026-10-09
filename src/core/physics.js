// Shared voxel physics: AABB-vs-voxel movement with step-up, voxel DDA raycast, ground probing.
// Used by player, peds, cops, vehicles, projectiles, camera. World must implement getBlock / isSolid.
import * as THREE from 'three';
import { WORLD } from './config.js';
import { BLOCKS } from '../world/blocks.js';

const EPS = 1e-4;

/** True if the axis-aligned box (bottom-centre x,y,z; half-width hw; height h) overlaps any solid voxel. */
export function boxCollides(world, x, y, z, hw, h) {
  const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw - EPS);
  const y0 = Math.floor(y), y1 = Math.floor(y + h - EPS);
  const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw - EPS);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (world.isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * Move a box through the voxel world resolving collisions per axis (Y, then X, then Z), with sub-stepping.
 *   pos  (Vector3, bottom-centre) is modified in place.
 *   vel  (Vector3) is modified: the component along a blocked axis is zeroed.
 *   opts.stepHeight  max ledge height climbed automatically when blocked horizontally while on ground
 *                    (1.0 = auto-jump onto single blocks; vehicles use ~1.05). Default 0.
 * Returns `out` = { onGround, hitX, hitY, hitZ, hitCeil, stepped, inWater, headInWater }.
 */
export function moveBox(world, pos, hw, h, vel, dt, opts = {}, out = {}) {
  const stepHeight = opts.stepHeight || 0;
  out.onGround = false; out.hitX = false; out.hitY = false; out.hitZ = false; out.hitCeil = false; out.stepped = 0;
  let dx = vel.x * dt, dy = vel.y * dt, dz = vel.z * dt;
  const maxd = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const n = Math.max(1, Math.ceil(maxd / 0.4));
  dx /= n; dy /= n; dz /= n;
  for (let i = 0; i < n; i++) {
    // ---- Y ----
    if (dy !== 0) {
      const ny = pos.y + dy;
      if (boxCollides(world, pos.x, ny, pos.z, hw, h)) {
        if (dy < 0) { pos.y = Math.floor(ny) + 1; out.onGround = true; }
        else { pos.y = Math.floor(ny + h - EPS) - h; out.hitCeil = true; }
        vel.y = 0; dy = 0; out.hitY = true;
      } else {
        pos.y = ny;
      }
    }
    // ---- X ----
    if (dx !== 0) {
      const nx = pos.x + dx;
      if (boxCollides(world, nx, pos.y, pos.z, hw, h)) {
        if (!tryStep(world, pos, nx, pos.z, hw, h, stepHeight, out)) {
          pos.x = dx > 0 ? Math.floor(nx + hw - EPS) - hw : Math.floor(nx - hw) + 1 + hw;
          vel.x = 0; dx = 0; out.hitX = true;
        }
      } else {
        pos.x = nx;
      }
    }
    // ---- Z ----
    if (dz !== 0) {
      const nz = pos.z + dz;
      if (boxCollides(world, pos.x, pos.y, nz, hw, h)) {
        if (!tryStep(world, pos, pos.x, nz, hw, h, stepHeight, out)) {
          pos.z = dz > 0 ? Math.floor(nz + hw - EPS) - hw : Math.floor(nz - hw) + 1 + hw;
          vel.z = 0; dz = 0; out.hitZ = true;
        }
      } else {
        pos.z = nz;
      }
    }
  }
  // Ground probe when we did not move vertically this frame (resting exactly on a block top).
  if (!out.onGround && vel.y <= 0 && Math.abs(pos.y - Math.round(pos.y)) < 1e-3) {
    if (boxCollides(world, pos.x, pos.y - 0.05, pos.z, hw, 0.05)) out.onGround = true;
  }
  const feet = world.getBlock(Math.floor(pos.x), Math.floor(pos.y + 0.4), Math.floor(pos.z));
  const head = world.getBlock(Math.floor(pos.x), Math.floor(pos.y + h * 0.85), Math.floor(pos.z));
  out.inWater = !!(BLOCKS[feet] && BLOCKS[feet].liquid);
  out.headInWater = !!(BLOCKS[head] && BLOCKS[head].liquid);
  return out;
}

function tryStep(world, pos, nx, nz, hw, h, stepHeight, out) {
  if (stepHeight <= 0 || !out.onGround) return false;
  const ty = Math.floor(pos.y + EPS) + 1;
  if (ty - pos.y > stepHeight + EPS) return false;
  if (boxCollides(world, nx, ty, nz, hw, h)) return false;
  out.stepped += ty - pos.y;
  pos.y = ty; pos.x = nx; pos.z = nz;
  return true;
}

/**
 * Voxel DDA raycast. Returns null or
 *   { x, y, z, id, normal: Vector3 (face entered; zero if origin inside block), point: Vector3, distance }
 * opts.hitLiquid (default false): stop at water.
 * opts.hitNonSolid (default true): stop at non-solid blocks like plants (useful for mining). Set false for bullets/camera.
 */
export function voxelRaycast(world, origin, dir, maxDist, opts = {}) {
  const hitLiquid = !!opts.hitLiquid;
  const hitNonSolid = opts.hitNonSolid !== false;
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const sx = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const sy = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const sz = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
  const tdx = sx !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tdz = sz !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tmx = sx > 0 ? (x + 1 - origin.x) * tdx : sx < 0 ? (origin.x - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - origin.y) * tdy : sy < 0 ? (origin.y - y) * tdy : Infinity;
  let tmz = sz > 0 ? (z + 1 - origin.z) * tdz : sz < 0 ? (origin.z - z) * tdz : Infinity;
  let t = 0, nx = 0, ny = 0, nz = 0;
  for (let guard = 0; guard < 2048 && t <= maxDist; guard++) {
    const id = world.getBlock(x, y, z);
    if (id !== 0) {
      const def = BLOCKS[id];
      const accept = def && (def.liquid ? hitLiquid : (def.solid || hitNonSolid));
      if (accept) {
        return {
          x, y, z, id,
          normal: new THREE.Vector3(nx, ny, nz),
          point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
          distance: t,
        };
      }
    }
    if (tmx < tmy) {
      if (tmx < tmz) { x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    } else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
    if (y < -1 || y > WORLD.HEIGHT + 1) break;
  }
  return null;
}

/** Standing height (top face y of the first solid block found scanning down from startY), or -1. */
export function findGround(world, x, z, startY = WORLD.HEIGHT - 1) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = Math.min(startY, WORLD.HEIGHT - 1); y >= 0; y--) {
    if (world.isSolid(bx, y, bz)) return y + 1;
  }
  return -1;
}

/** Line of sight between two points (no solid block in between). */
export function hasLineOfSight(world, from, to) {
  const d = new THREE.Vector3().subVectors(to, from);
  const len = d.length();
  if (len < 1e-3) return true;
  d.divideScalar(len);
  const hit = voxelRaycast(world, from, d, len, { hitNonSolid: false });
  return !hit;
}
