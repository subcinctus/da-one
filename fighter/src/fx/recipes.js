// Effect recipes: small, clean, Absolver-like. Each writes a handful of particles into the SpriteField through the
// shared SPRITE params object (no allocations). Colours are display RGB.
import { SPRITE as P, resetSprite, SHAPE, ORIENT } from './sprites.js';

export const COLORS = {
  white: [1, 0.99, 0.96],
  shard: [1, 0.97, 0.92],
  block: [0.72, 0.82, 0.95],
  parry: [0.93, 0.97, 1],
  jade: [0.37, 0.75, 0.6],
  jadeLight: [0.66, 0.93, 0.82],
  dust: [0.8, 0.77, 0.71],
  glint: [1, 0.95, 0.84],
};

/** Per-weight hit look: flash radius / life, shard count range, speeds, streak length. */
export const HIT = {
  light: { flash: 0.1, star: 0.16, life: 0.05, n0: 4, n1: 5, s0: 3.2, s1: 5.6, len: 0.07, width: 0.011, ring: false },
  medium: { flash: 0.125, star: 0.2, life: 0.06, n0: 6, n1: 7, s0: 3.8, s1: 6.8, len: 0.09, width: 0.013, ring: false },
  heavy: { flash: 0.16, star: 0.27, life: 0.075, n0: 8, n1: 10, s0: 4.4, s1: 8.0, len: 0.12, width: 0.016, ring: true },
};

const _d = [0, 0, 0];
const rnd = Math.random;

/** Random unit vector within `spread` radians of (dx, dy, dz) (written into _d). */
function cone(dx, dy, dz, spread) {
  let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-5) { dx = 0; dy = 0; dz = 1; l = 1; }
  dx /= l; dy /= l; dz /= l;
  // orthonormal basis around d
  let ax = 0, ay = 1, az = 0;
  if (Math.abs(dy) > 0.9) { ax = 1; ay = 0; }
  let ux = ay * dz - az * dy, uy = az * dx - ax * dz, uz = ax * dy - ay * dx;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const th = rnd() * Math.PI * 2, r = Math.sin(spread * Math.sqrt(rnd())), c = Math.sqrt(Math.max(0, 1 - r * r));
  const cu = Math.cos(th) * r, cv = Math.sin(th) * r;
  _d[0] = dx * c + ux * cu + vx * cv;
  _d[1] = dy * c + uy * cu + vy * cv;
  _d[2] = dz * c + uz * cu + vz * cv;
  return _d;
}

/** Flash disc: a hard white core with a faint halo, 2-3 frames. */
export function flash(F, x, y, z, size, life, col, alpha = 0.95, add = 0.85) {
  resetSprite(P);
  P.x = x; P.y = y; P.z = z;
  P.shape = SHAPE.FLASH; P.core = 0.42; P.orient = ORIENT.CAMERA; P.spin = rnd() * 6.283;
  P.size0 = size * 0.75; P.size1 = size * 1.2; P.grow = 3;
  P.life = life; P.alpha = alpha; P.add = add; P.pull = 0.22; P.fadePow = 2;
  P.r = col[0]; P.g = col[1]; P.b = col[2];
  return F.spawn(P);
}

/** Impact star: two thin crossing glints through the flash (one along the strike, one across it). */
export function star(F, x, y, z, dx, dy, dz, len, width, life, col, alpha = 1) {
  let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-5) { dx = 1; dy = 0; dz = 0; l = 1; }
  dx /= l; dy /= l; dz /= l;
  // across = dir x up (horizontal strike -> vertical-ish glint after camera facing)
  let cx = -dz, cy = 0.35, cz = dx;
  const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  cx /= cl; cy /= cl; cz /= cl;
  for (let k = 0; k < 2; k++) {
    resetSprite(P);
    P.x = x; P.y = y; P.z = z;
    if (k === 0) { P.nx = dx; P.ny = dy + 0.12; P.nz = dz; } else { P.nx = cx; P.ny = cy + 0.6; P.nz = cz; }
    P.shape = SHAPE.SHARD; P.orient = ORIENT.STREAK;
    P.size0 = len * (k === 0 ? 1 : 0.7); P.size1 = P.size0 * 1.25; P.width = width; P.grow = 3;
    P.life = life; P.alpha = alpha; P.add = 0.9; P.pull = 0.24; P.fadePow = 1.6;
    P.r = col[0]; P.g = col[1]; P.b = col[2];
    // streaks are drawn trailing their point: centre them on the impact
    P.x += P.nx * P.size0 * 0.5; P.y += P.ny * P.size0 * 0.5; P.z += P.nz * P.size0 * 0.5;
    F.spawn(P);
  }
}

/** Thin ring. Normal (nx, ny, nz) = 0 -> camera facing. r0 -> r1 (contracts when r1 < r0). */
export function ring(F, x, y, z, nx, ny, nz, r0, r1, thick, life, col, alpha, o = null) {
  resetSprite(P);
  P.x = x; P.y = y; P.z = z;
  P.shape = SHAPE.RING;
  if (nx || ny || nz) { P.orient = ORIENT.PLANE; P.nx = nx; P.ny = ny; P.nz = nz; } else P.orient = ORIENT.CAMERA;
  P.size0 = r0; P.size1 = r1; P.width = thick; P.grow = 3;
  P.life = life; P.alpha = alpha; P.add = 0.9; P.pull = 0.12; P.fadePow = 1.5;
  P.r = col[0]; P.g = col[1]; P.b = col[2];
  if (o) {
    if (o.delay) P.delay = o.delay;
    if (o.fadeIn) P.fadeIn = o.fadeIn;
    if (o.fadePow !== undefined) P.fadePow = o.fadePow;
    if (o.grow !== undefined) P.grow = o.grow;
    if (o.add !== undefined) P.add = o.add;
    if (o.pull !== undefined) P.pull = o.pull;
  }
  return F.spawn(P);
}

/** Tiny angular shards / sparks flying along (dx, dy, dz) within a cone. */
export function shards(F, x, y, z, dx, dy, dz, count, s0, s1, spread, len, width, life, col, alpha = 0.95, up = 0.2, grav = 2.5) {
  for (let k = 0; k < count; k++) {
    const d = cone(dx, dy + up, dz, spread);
    const sp = s0 + (s1 - s0) * rnd();
    resetSprite(P);
    P.x = x + d[0] * 0.03; P.y = y + d[1] * 0.03; P.z = z + d[2] * 0.03;
    P.vx = d[0] * sp; P.vy = d[1] * sp; P.vz = d[2] * sp;
    P.nx = d[0]; P.ny = d[1]; P.nz = d[2];
    P.shape = SHAPE.SHARD; P.orient = ORIENT.STREAK;
    P.size0 = len * (0.7 + 0.6 * rnd()); P.size1 = P.size0 * 0.35; P.width = width * (0.7 + 0.5 * rnd()); P.grow = 1.5;
    P.life = life * (0.75 + 0.5 * rnd()); P.alpha = alpha; P.add = 0.8; P.drag = 7; P.grav = grav; P.pull = 0.1; P.fadePow = 1.2;
    P.r = col[0]; P.g = col[1]; P.b = col[2];
    F.spawn(P);
  }
}

/** Soft puff (normal blending): dust, chalk, glows (set add). */
export function puff(F, x, y, z, vx, vy, vz, s0, s1, life, col, alpha, add = 0, delay = 0) {
  resetSprite(P);
  P.x = x; P.y = y; P.z = z; P.vx = vx; P.vy = vy; P.vz = vz;
  P.shape = SHAPE.SOFT; P.core = 0.15; P.orient = ORIENT.CAMERA; P.spin = rnd() * 6.283;
  P.size0 = s0; P.size1 = s1; P.grow = 2.2;
  P.life = life; P.delay = delay; P.alpha = alpha; P.add = add; P.drag = 4.5; P.grav = -0.15; P.fadePow = 1.4; P.fadeIn = 0.12;
  P.r = col[0]; P.g = col[1]; P.b = col[2];
  return F.spawn(P);
}

/** Particles converging on a point from a ring around it (absorb). */
export function inward(F, x, y, z, count, radius, life, len, width, col, alpha) {
  for (let k = 0; k < count; k++) {
    const d = cone(0, 0.2, 0, Math.PI);   // any direction, slightly up-biased
    const px = x + d[0] * radius, py = y + d[1] * radius * 0.7, pz = z + d[2] * radius;
    const sp = radius / life;
    resetSprite(P);
    P.x = px; P.y = py; P.z = pz;
    P.vx = (x - px) / radius * sp; P.vy = (y - py) / radius * sp; P.vz = (z - pz) / radius * sp;
    P.shape = SHAPE.SHARD; P.orient = ORIENT.STREAK;
    P.size0 = len; P.size1 = len * 0.5; P.width = width; P.grow = 1.2;
    P.life = life * (0.85 + 0.2 * rnd()); P.alpha = alpha; P.add = 0.9; P.fadeIn = 0.25; P.fadePow = 0.8; P.pull = 0.08;
    P.r = col[0]; P.g = col[1]; P.b = col[2];
    F.spawn(P);
  }
}

/** Rising streaks around a vertical axis (learned-move flourish, heal sparkle). */
export function rising(F, x, y, z, count, radius, h0, h1, s0, s1, len, width, life, col, alpha) {
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + rnd() * 0.6;
    const r = radius * (0.7 + 0.3 * rnd());
    const sp = s0 + (s1 - s0) * rnd();
    resetSprite(P);
    P.x = x + Math.cos(a) * r; P.y = y + h0 + (h1 - h0) * rnd(); P.z = z + Math.sin(a) * r;
    P.vx = 0; P.vy = sp; P.vz = 0; P.nx = 0; P.ny = 1; P.nz = 0;
    P.shape = SHAPE.SHARD; P.orient = ORIENT.STREAK;
    P.size0 = len; P.size1 = len * 0.4; P.width = width; P.grow = 1.5;
    P.life = life * (0.8 + 0.4 * rnd()); P.delay = rnd() * 0.12; P.alpha = alpha; P.add = 0.9; P.drag = 1.5; P.fadeIn = 0.15;
    P.r = col[0]; P.g = col[1]; P.b = col[2];
    F.spawn(P);
  }
}

/** Telegraph glint: a tiny sparkle on a limb, drifting with the fighter (vx, vz). Hard core + faint halo, 2 sprites. */
export function glint(F, x, y, z, vx, vz, size, life, col, alpha) {
  resetSprite(P);
  P.x = x; P.y = y; P.z = z; P.vx = vx; P.vz = vz;
  P.shape = SHAPE.FLASH; P.core = 0.5; P.orient = ORIENT.CAMERA; P.spin = 0.785;
  P.size0 = size * 0.5; P.size1 = size; P.grow = 3;
  P.life = life; P.alpha = alpha; P.add = 0.95; P.pull = 0.18; P.fadePow = 1.5; P.fadeIn = 0.2;
  P.r = col[0]; P.g = col[1]; P.b = col[2];
  F.spawn(P);
  resetSprite(P);
  P.x = x; P.y = y; P.z = z; P.vx = vx; P.vz = vz;
  P.shape = SHAPE.SOFT; P.core = 0.1; P.orient = ORIENT.CAMERA;
  P.size0 = size * 1.1; P.size1 = size * 1.7; P.grow = 2;
  P.life = life; P.alpha = alpha * 0.35; P.add = 1; P.pull = 0.18; P.fadePow = 1.4; P.fadeIn = 0.2;
  P.r = col[0]; P.g = col[1]; P.b = col[2];
  return F.spawn(P);
}
