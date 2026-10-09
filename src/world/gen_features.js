// Small world features (trees, palms, rocks, street lamps, beach umbrellas...).
// Placed once at plan time (deterministic), binned per chunk, stamped into chunk data clipped to the chunk.
import { B } from './blocks.js';
import { h2, h3, N } from './gen_const.js';

export const F_OAK = 1, F_SPRUCE = 2, F_PALM = 3, F_BUSH = 4, F_ROCK = 5, F_LAMP = 6, F_UMBRELLA = 7, F_STREETTREE = 8, F_BIGOAK = 9, F_PARKLAMP = 10, F_HAYBALE = 11;

const LEAVES = B.LEAVES, LOG = B.LOG;
const SOFT = new Uint8Array(256); // blocks that features may overwrite with foliage
SOFT[B.AIR] = 1; SOFT[B.TALL_GRASS] = 1; SOFT[B.FLOWER_RED] = 1; SOFT[B.FLOWER_YELLOW] = 1; SOFT[B.SNOW] = 0;

/** Feature record. r = horizontal reach (for binning). */
export function feat(t, x, z, y, a = 0, b = 0, r = 2) { return { t, x, z, y, a, b, r }; }

// ---- chunk write helpers (world coordinates, clipped) ----
export function setv(ctx, x, y, z, id) {
  const lx = x - ctx.ox, lz = z - ctx.oz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y > 95) return;
  ctx.data[lx + (lz << 4) + (y << 8)] = id;
}
export function getv(ctx, x, y, z) {
  const lx = x - ctx.ox, lz = z - ctx.oz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y > 95) return -1;
  return ctx.data[lx + (lz << 4) + (y << 8)];
}
export function setSoft(ctx, x, y, z, id) {
  const lx = x - ctx.ox, lz = z - ctx.oz;
  if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y > 95) return;
  const k = lx + (lz << 4) + (y << 8);
  if (SOFT[ctx.data[k]]) ctx.data[k] = id;
}

function crownLayer(ctx, cx, y, cz, r, cut, salt) {
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const corner = Math.abs(dx) === r && Math.abs(dz) === r;
      if (corner && (cut || h3(cx + dx, y, cz + dz, salt) < 0.6)) continue;
      setSoft(ctx, cx + dx, y, cz + dz, LEAVES);
    }
  }
}

/** Stamp one feature into the chunk ctx {data, ox, oz}. */
export function stampFeature(ctx, f) {
  const { x, z, y } = f;
  switch (f.t) {
    case F_OAK: case F_BIGOAK: {
      const h = f.a, r = f.b;
      const top = y + h - 1;
      crownLayer(ctx, x, top - 1, z, r, false, 7);
      crownLayer(ctx, x, top, z, r, false, 9);
      if (f.t === F_BIGOAK) crownLayer(ctx, x, top - 2, z, r - 1, true, 5);
      crownLayer(ctx, x, top + 1, z, Math.max(1, r - 1), true, 3);
      setSoft(ctx, x, top + 2, z, LEAVES);
      setSoft(ctx, x + 1, top + 2, z, LEAVES); setSoft(ctx, x - 1, top + 2, z, LEAVES);
      setSoft(ctx, x, top + 2, z + 1, LEAVES); setSoft(ctx, x, top + 2, z - 1, LEAVES);
      for (let yy = y; yy <= top; yy++) setv(ctx, x, yy, z, LOG);
      break;
    }
    case F_SPRUCE: {
      const h = f.a;
      const top = y + h;
      // conical crown: alternating radius, widest near the bottom
      let layer = 0;
      for (let yy = top; yy >= y + 2; yy--, layer++) {
        const r = layer === 0 ? 0 : layer === 1 ? 1 : (layer % 2 === 0 ? Math.min(2 + (layer > 5 ? 1 : 0), 3) : 1);
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (r > 0 && Math.abs(dx) + Math.abs(dz) > r + (r > 1 ? 1 : 0)) continue;
            setSoft(ctx, x + dx, yy, z + dz, LEAVES);
          }
        }
      }
      setSoft(ctx, x, top + 1, z, LEAVES);
      for (let yy = y; yy < top; yy++) setv(ctx, x, yy, z, LOG);
      break;
    }
    case F_PALM: {
      const h = f.a, dir = f.b;
      const ddx = dir === 0 ? 1 : dir === 2 ? -1 : 0, ddz = dir === 1 ? 1 : dir === 3 ? -1 : 0; // dir 4 = straight
      let tx = x, tz = z;
      for (let k = 0; k < h; k++) {
        if (k === Math.floor(h * 0.55)) { tx += ddx; tz += ddz; }
        setv(ctx, tx, y + k, tz, B.PALM_LOG);
      }
      const ty = y + h;
      setv(ctx, tx, ty, tz, B.PALM_LEAVES);
      setSoft(ctx, tx, ty + 1, tz, B.PALM_LEAVES);
      const arms = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [ax, az] of arms) {
        setSoft(ctx, tx + ax, ty, tz + az, B.PALM_LEAVES);
        setSoft(ctx, tx + ax * 2, ty, tz + az * 2, B.PALM_LEAVES);
        setSoft(ctx, tx + ax * 3, ty - 1, tz + az * 3, B.PALM_LEAVES);
        setSoft(ctx, tx + ax * 4, ty - 2, tz + az * 4, B.PALM_LEAVES);
      }
      for (const [ax, az] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        setSoft(ctx, tx + ax, ty, tz + az, B.PALM_LEAVES);
        setSoft(ctx, tx + ax * 2, ty - 1, tz + az * 2, B.PALM_LEAVES);
      }
      break;
    }
    case F_BUSH: {
      const id = f.b ? B.HEDGE : LEAVES;
      const r = f.a;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > r + 0) continue;
          setSoft(ctx, x + dx, y, z + dz, id);
          if (dx === 0 && dz === 0 && r > 0) setSoft(ctx, x, y + 1, z, id);
        }
      }
      break;
    }
    case F_ROCK: {
      const r = f.a;
      const id1 = f.b ? B.COBBLESTONE : B.STONE;
      for (let dy = -1; dy <= r; dy++) {
        const rr = r - Math.max(0, dy);
        for (let dz = -rr; dz <= rr; dz++) {
          for (let dx = -rr; dx <= rr; dx++) {
            if (dx * dx + dz * dz + dy * dy > r * r + 1) continue;
            if (h3(x + dx, y + dy, z + dz, 77) < 0.15) continue;
            setv(ctx, x + dx, y + dy, z + dz, h3(x + dx, y + dy, z + dz, 78) < 0.35 ? B.COBBLESTONE : id1);
          }
        }
      }
      break;
    }
    case F_LAMP: {
      const h = f.a || 4;
      for (let k = 0; k < h; k++) setv(ctx, x, y + k, z, B.METAL);
      setv(ctx, x, y + h, z, B.LAMP);
      break;
    }
    case F_PARKLAMP: {
      for (let k = 0; k < 3; k++) setv(ctx, x, y + k, z, B.METAL);
      setv(ctx, x, y + 3, z, B.LAMP);
      break;
    }
    case F_STREETTREE: {
      // planter tree on a sidewalk: trunk 4, compact crown at y+4.. so walkers & buses pass underneath
      setv(ctx, x, y - 1, z, B.GRASS);
      for (let k = 0; k < 4; k++) setv(ctx, x, y + k, z, LOG);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        setSoft(ctx, x + dx, y + 4, z + dz, LEAVES);
        if (Math.abs(dx) + Math.abs(dz) < 2) setSoft(ctx, x + dx, y + 5, z + dz, LEAVES);
      }
      setv(ctx, x, y + 4, z, LOG);
      setSoft(ctx, x, y + 6, z, LEAVES);
      break;
    }
    case F_UMBRELLA: {
      const c = f.a;
      for (let k = 0; k < 3; k++) setv(ctx, x, y + k, z, B.METAL);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        setv(ctx, x + dx, y + 3, z + dz, (dx + dz + 4) % 2 === 0 ? c : B.WOOL_WHITE);
      }
      setv(ctx, x, y + 4, z, c);
      // towel on the sand next to it
      const tx = x + (f.b ? 2 : -2);
      setv(ctx, tx, y - 1, z, c === B.WOOL_WHITE ? B.WOOL_BLUE : c);
      setv(ctx, tx, y - 1, z + 1, c === B.WOOL_WHITE ? B.WOOL_BLUE : c);
      break;
    }
    case F_HAYBALE: {
      setv(ctx, x, y, z, B.WOOL_YELLOW);
      if (f.a) setv(ctx, x, y, z + 1, B.WOOL_YELLOW);
      if (f.b) setv(ctx, x, y + 1, z, B.WOOL_YELLOW);
      break;
    }
    default: break;
  }
}

/** Map colour of a feature's canopy (for colorAt), or 0 for none. */
export function featureMapColor(f) {
  switch (f.t) {
    case F_OAK: case F_BIGOAK: case F_STREETTREE: return 0x2f6a24;
    case F_SPRUCE: return 0x24502a;
    case F_PALM: return 0x4a8f2c;
    case F_BUSH: return 0x3a7a2c;
    case F_ROCK: return 0x8a8a86;
    default: return 0;
  }
}

/** Horizontal map footprint radius used for map painting. */
export function featureMapRadius(f) {
  switch (f.t) {
    case F_OAK: return f.b;
    case F_BIGOAK: return f.b;
    case F_SPRUCE: return 2;
    case F_PALM: return 2;
    case F_STREETTREE: return 1;
    case F_BUSH: return f.a;
    case F_ROCK: return f.a;
    default: return 0;
  }
}

/** Bin features into per-chunk lists by their reach. */
export function binFeatures(features, chunkLists) {
  for (const f of features) {
    const r = f.r;
    const cx0 = Math.max(0, (f.x - r) >> 4), cx1 = Math.min((N >> 4) - 1, (f.x + r) >> 4);
    const cz0 = Math.max(0, (f.z - r) >> 4), cz1 = Math.min((N >> 4) - 1, (f.z + r) >> 4);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) chunkLists[cz * (N >> 4) + cx].push(f);
  }
}

export { h2 };
