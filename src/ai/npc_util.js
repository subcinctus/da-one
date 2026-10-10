// Shared helpers for the NPC systems (traffic + pedestrians). NPC agent.
import * as THREE from 'three';

const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
let _frustumFrame = -1;
let _frustumGame = null;

/** Camera frustum, refreshed at most once per frame (uses the previous render's camera matrices). */
function frustum(game) {
  if (_frustumFrame !== game.frame || _frustumGame !== game) {
    _frustumFrame = game.frame;
    _frustumGame = game;
    const cam = game.camera;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
  }
  return _frustum;
}

/** Radius (m) of the area the world keeps loaded / visible (fog ends about here). */
export function viewRadius(game) {
  const rd = (game.world && game.world.renderDistance) || (game.settings && game.settings.renderDistance) || 6;
  return Math.max(48, rd * 16);
}

/**
 * True if a sphere at (x, y, z) with radius r is inside the camera frustum and closer than the fog.
 * Objects behind walls still count as visible (cheap, conservative).
 */
export function isVisible(game, x, y, z, r = 2) {
  if (!game.camera) return false;
  const cp = game.camera.position;
  const dx = x - cp.x, dz = z - cp.z;
  const vr = viewRadius(game) + r;
  if (dx * dx + dz * dz > vr * vr) return false;
  _sphere.center.set(x, y, z);
  _sphere.radius = r;
  return frustum(game).intersectsSphere(_sphere);
}

/** Voxel data for the chunk containing (x, z) already exists (so physics there will not trigger generation). */
export function chunkReady(game, x, z) {
  const w = game.world;
  if (!w || !w.chunks || typeof w.chunks.has !== 'function') return true;
  return w.chunks.has((Math.floor(x) >> 4) + ',' + (Math.floor(z) >> 4));
}

/** Population multiplier from the render distance setting: 4 -> 0.85, 6 -> 1.0, 8 -> 1.15, capped. */
export function densityScale(game) {
  const rd = (game.settings && game.settings.renderDistance) || 6;
  return Math.max(0.7, Math.min(1.25, 0.55 + 0.075 * rd));
}

/** Weighted random pick from [[value, weight], ...]. */
export function weighted(table, rng = Math.random) {
  let total = 0;
  for (let i = 0; i < table.length; i++) total += table[i][1];
  let r = rng() * total;
  for (let i = 0; i < table.length; i++) { r -= table[i][1]; if (r <= 0) return table[i][0]; }
  return table[table.length - 1][0];
}

export const rand = (a, b) => a + Math.random() * (b - a);
export const chance = (p) => Math.random() < p;

/** Districts where the gang (the "Anvil Kings") hangs out. */
export const GANG_DISTRICTS = new Set(['port', 'industrial']);

/** Pedestrian density per district (multiplies the base count). */
export const PED_DENSITY = {
  downtown: 1.35, midtown: 1.15, market: 1.25, oldtown: 1.05, bayfront: 1.0, residential: 0.8, park: 0.9,
  industrial: 0.65, port: 0.7, beach: 0.85,
};

/** Is the selected inventory item a gun (something you can aim at people)? */
export function playerHoldsGun(game, WEAPONS) {
  const it = game.inventory && typeof game.inventory.getSelected === 'function' ? game.inventory.getSelected() : null;
  if (!it || it.kind !== 'weapon') return false;
  const d = WEAPONS[it.id];
  return !!d && (d.kind === 'hitscan' || d.kind === 'projectile');
}
