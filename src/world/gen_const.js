// Shared constants + tiny helpers for the world generator (WORLD-GEN agent).
// Everything here is pure data / pure functions so the generator stays importable in Node.
import { WORLD } from '../core/config.js';
import { B } from './blocks.js';

export const N = WORLD.SIZE_X;            // 512 (map is square)
export const H = WORLD.HEIGHT;            // 96
export const CL = WORLD.CITY_LEVEL;       // 28 standing height of the city
export const RY = CL - 1;                 // 27 y of road / sidewalk blocks
export const SEA = WORLD.SEA_LEVEL;       // 24 -> water fills y <= 23
export const WATER_TOP = SEA - 1;         // 23
export const SIDEWALK_W = 3;

// ---- per-column mask bits (plan.mask) ----
export const M_ROAD = 1;       // asphalt / paint (cars drive here)
export const M_SIDEWALK = 2;   // sidewalk (peds walk here)
export const M_WATER = 4;      // column has water on top (sea, lake, river, pond, pool)
export const M_CITY = 8;       // inside the flat city footprint (ground forced to CITY_LEVEL)
export const M_TUNNEL = 16;    // road column inside a tunnel (ceiling above)
export const M_BRIDGE = 32;    // road column on a bridge deck
export const M_SHOULDER = 64;  // gravel / concrete shoulder next to a country road or highway
export const M_NOPROP = 128;   // keep clear: no lamps / trees (driveways, crosswalks, entrances)

// ---- road structure flags (plan.rflag) ----
export const R_TUNWALL = 1;    // tunnel side wall column
export const R_PILLAR = 2;     // bridge pillar column
export const R_RAIL = 4;       // bridge railing column
export const R_CEILLAMP = 8;   // tunnel ceiling lamp
export const R_PORTAL = 16;    // tunnel portal frame column

// ---- surface material codes (plan.surf) for terrain columns ----
export const S_GRASS = 0, S_SAND = 1, S_SNOW = 2, S_STONE = 3, S_GRAVEL = 4, S_DIRT = 5, S_CITY = 6, S_SANDBED = 7, S_FIELD = 8;

// Speed limits (m/s) + geometry for each road kind.
export const ROAD_KINDS = {
  street:  { width: 8, lanes: 1, speedLimit: 13 },
  avenue:  { width: 12, lanes: 2, speedLimit: 17 },
  highway: { width: 12, lanes: 2, speedLimit: 28 },
  country: { width: 8, lanes: 1, speedLimit: 20 },
};

// City grid: road centre lines (same on X and Z). Even index = avenue, odd = street.
export const GRID = [104, 140, 176, 212, 248, 284, 320, 356, 392];
export const gridHalf = (i) => (i % 2 === 0 ? 6 : 4);
export const CITY_X0 = GRID[0] - 6 - SIDEWALK_W;             // 95
export const CITY_X1 = GRID[GRID.length - 1] + 6 + SIDEWALK_W; // 401 (exclusive)

// Ring road + countryside layout (fixed; seed varies the details).
export const RING = { x0: 72, z0: 72, x1: 432, z1: 436 };
export const MINE = {
  roadX: 136, roadEndZ: 50,                       // mine road dead-end (node)
  tunnelA: { x0: 133, x1: 140, z0: 38, z1: 50 },   // flat entrance gallery (y 28..32)
  ramp: { x0: 140, x1: 172, z0: 37, z1: 43, yTop: 27, yBottom: 11 }, // descending gallery (floor y)
  cavern: { cx: 184, cy: 17, cz: 40, rx: 13, ry: 8, rz: 11, floorY: 11 },
};
export const LAKE = { cx: 58, cz: 270, rx: 22, rz: 30 };
export const RIVER = [[74, 24], [60, 46], [46, 76], [52, 112], [40, 152], [50, 194], [46, 236]];
export const OUTFLOW = [[44, 286], [28, 298], [12, 304], [0, 306]];
export const BEACH = { z0: 98, z1: 330, boardX0: 441, boardX1: 445, waterX: 458 };
export const PORT = { x0: 401, x1: 463, z0: 330, z1: 432, quayX: 463 };
export const PIER = { x0: 445, x1: 501, z0: 226, z1: 233 };
export const FARM = { x0: 92, x1: 214, z0: 446, z1: 486, roadX: 148 };

// ---- districts ----
export const DISTRICTS = [
  { id: 'downtown', name: 'Downtown Blockton' },
  { id: 'midtown', name: 'Voxel Heights' },
  { id: 'oldtown', name: 'Old Cobbleton' },
  { id: 'park', name: 'Greenblock Park' },
  { id: 'residential', name: 'Birchwood Terrace' },
  { id: 'bayfront', name: 'Coral Bayfront' },
  { id: 'market', name: 'Crafter\'s Market' },
  { id: 'industrial', name: 'Ironworks' },
  { id: 'port', name: 'Port Anvil' },
  { id: 'beach', name: 'Sunstone Beach' },
  { id: 'mountains', name: 'Granite Peaks' },
  { id: 'hills', name: 'Rolling Meadows' },
  { id: 'forest', name: 'Pinewood Forest' },
  { id: 'lake', name: 'Mirror Lake' },
  { id: 'farm', name: 'Hayfield Farm' },
  { id: 'ocean', name: 'Blue Expanse' },
];
export const DIST = {};
DISTRICTS.forEach((d, i) => { DIST[d.id] = i; });

// District of each city superblock [sz][sx] (superblock = 2x2 city blocks between avenues).
export const DGRID = [
  ['oldtown', 'oldtown', 'midtown', 'midtown'],
  ['residential', 'park', 'downtown', 'bayfront'],
  ['residential', 'downtown', 'downtown', 'bayfront'],
  ['residential', 'market', 'industrial', 'port'],
];

// Facing (front side of a lot): 0 = N (-z), 1 = E (+x), 2 = S (+z), 3 = W (-x)
export const FACE_DX = [0, 1, 0, -1];
export const FACE_DZ = [-1, 0, 1, 0];
/** Yaw that faces back toward a building whose front is `face` (standing on the street, looking at the door). */
export const YAW_TO_FRONT = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

// Palettes
export const WOOLS = [B.WOOL_RED, B.WOOL_BLUE, B.WOOL_YELLOW, B.WOOL_GREEN, B.WOOL_WHITE, B.WOOL_ORANGE, B.WOOL_PURPLE];
export const CONTAINER_COLORS = [B.WOOL_RED, B.WOOL_BLUE, B.WOOL_GREEN, B.WOOL_ORANGE, B.WOOL_YELLOW, B.WOOL_WHITE, B.WOOL_PURPLE, B.WOOL_BLUE, B.WOOL_RED];

// ---- helpers ----
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Fast integer hash -> [0,1). Same quality as core hash2 but with 3 int inputs + seed. */
export function h3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 1103515245) + Math.imul(z | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function h2(x, z, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Distance from point to segment (2D). */
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

/** Distance from point to polyline [[x,z],...]. */
export function polyDist(px, pz, pts) {
  let best = 1e9;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segDist(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

export const idx = (x, z) => z * N + x;
export const inMap = (x, z) => x >= 0 && z >= 0 && x < N && z < N;
