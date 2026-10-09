// Chunk voxel generation. Pure function of (plan rasters, seed, cx, cz): every structure that spans chunk borders
// comes from the plan (blueprint ops, binned features), so neighbouring chunks always agree.
import { B } from './blocks.js';
import { Noise } from '../core/noise.js';
import { makeRng } from '../core/math.js';
import {
  N, CL, RY, SEA, M_ROAD, M_SIDEWALK, M_CITY, M_TUNNEL, M_BRIDGE, M_SHOULDER, M_NOPROP,
  R_TUNWALL, R_PILLAR, R_RAIL, R_CEILLAMP, R_PORTAL, S_GRASS, S_SAND, S_SNOW, S_STONE, S_GRAVEL, S_DIRT, h2, h3,
} from './gen_const.js';
import { stampFeature } from './gen_features.js';

const CH = N >> 4;
const WATER_Y = SEA - 1; // 23
const TUN_TOP = CL + 6;  // tunnel ceiling y (34)

export class ChunkGen {
  constructor(seed, internal) {
    this.seed = seed;
    this.I = internal;
    this.caveA = new Noise(seed * 31 + 7);
    this.caveB = new Noise(seed * 37 + 19);
    this.lattice = new Float32Array(5 * 5 * 25 * 2);
    // per-chunk max terrain height (for cave + ore decisions)
    const { hgt, mask } = internal;
    this.chunkMax = new Uint8Array(CH * CH);
    this.chunkCave = new Uint8Array(CH * CH);
    for (let cz = 0; cz < CH; cz++) for (let cx = 0; cx < CH; cx++) {
      let mx = 0, city = false;
      for (let z = cz * 16; z < cz * 16 + 16; z++) for (let x = cx * 16; x < cx * 16 + 16; x++) {
        const i = z * N + x;
        if (hgt[i] > mx) mx = hgt[i];
        if (mask[i] & M_CITY) city = true;
      }
      this.chunkMax[cz * CH + cx] = mx;
      this.chunkCave[cz * CH + cx] = mx >= 44 && !city ? 1 : 0;
    }
  }

  generate(cx, cz) {
    const data = new Uint8Array(16 * 16 * 96);
    if (cx < 0 || cz < 0 || cx >= CH || cz >= CH) {
      // outside the map: bedrock + deep water (never happens through the contract, but stay safe)
      for (let k = 0; k < 256; k++) data[k] = B.BEDROCK;
      return data;
    }
    const ox = cx * 16, oz = cz * 16;
    const ctx = { data, ox, oz };
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) this.column(data, lx, lz, ox + lx, oz + lz);
    const ci = cz * CH + cx;
    if (this.chunkCave[ci]) this.caves(data, ox, oz);
    this.ores(data, cx, cz);
    for (const bp of this.I.chunkBps[ci]) {
      for (const op of bp.ops) {
        if (op.x1 <= ox || op.x0 >= ox + 16 || op.z1 <= oz || op.z0 >= oz + 16) continue;
        op.f(ctx);
      }
    }
    for (const f of this.I.chunkFeat[ci]) stampFeature(ctx, f);
    return data;
  }

  column(d, lx, lz, x, z) {
    const I = this.I;
    const i = z * N + x;
    const m = I.mask[i];
    const col = lx + (lz << 4);
    d[col] = B.BEDROCK;
    if (h2(x, z, 991) < 0.35) d[col + 256] = B.BEDROCK;
    if (m & M_CITY) {
      for (let y = d[col + 256] ? 2 : 1; y < 24; y++) d[col + (y << 8)] = B.STONE;
      d[col + (24 << 8)] = B.DIRT; d[col + (25 << 8)] = B.DIRT; d[col + (26 << 8)] = B.DIRT;
      d[col + (RY << 8)] = I.top[i] || B.GRASS;
      return;
    }
    const h = I.hgt[i];
    const s = I.surf[i];
    const topY = h - 1;
    // underground layers
    let filler = B.DIRT, topId = B.GRASS, fillDepth = 3;
    switch (s) {
      case S_SAND: filler = B.SAND; topId = B.SAND; fillDepth = 4; break;
      case S_SNOW: filler = B.STONE; topId = B.SNOW; fillDepth = 1; break;
      case S_STONE: filler = B.STONE; topId = B.STONE; fillDepth = 1; break;
      case S_GRAVEL: filler = B.GRAVEL; topId = B.GRAVEL; fillDepth = 2; break;
      case S_DIRT: filler = B.DIRT; topId = h3(x, h, z, 3) < 0.5 ? B.DIRT : B.GRASS; break;
      default: break;
    }
    if (topY < WATER_Y && s === S_GRASS) { topId = B.DIRT; }
    const stoneTop = topY - fillDepth;
    for (let y = d[col + 256] ? 2 : 1; y <= stoneTop; y++) d[col + (y << 8)] = B.STONE;
    for (let y = Math.max(1, stoneTop + 1); y < topY; y++) d[col + (y << 8)] = filler === B.SAND && y < topY - 2 ? B.SANDSTONE : filler;
    if (topY >= 1) d[col + (topY << 8)] = topId;
    // water
    for (let y = topY + 1; y <= WATER_Y; y++) d[col + (y << 8)] = B.WATER;

    if (m & (M_ROAD | M_SHOULDER)) {
      const roadTop = I.top[i] || (m & M_BRIDGE ? B.CONCRETE : B.GRAVEL);
      if (m & M_BRIDGE) {
        const rf = I.rflag[i];
        d[col + ((RY - 1) << 8)] = B.CONCRETE;
        d[col + (RY << 8)] = (m & M_SHOULDER) ? B.CONCRETE : roadTop;
        if (rf & R_RAIL) d[col + (CL << 8)] = B.METAL;
        if (rf & R_PILLAR) for (let y = Math.max(1, topY + 1); y < RY - 1; y++) d[col + (y << 8)] = B.CONCRETE;
        for (let y = CL + ((rf & R_RAIL) ? 1 : 0); y < 96; y++) if (d[col + (y << 8)] !== 0) d[col + (y << 8)] = 0; else if (y > h + 2) break;
      } else {
        // ground road: solid embankment below, clear above (cutting)
        for (let y = Math.max(1, topY + 1); y < RY; y++) d[col + (y << 8)] = y < RY - 2 ? B.STONE : B.DIRT;
        d[col + (RY << 8)] = roadTop;
        if (m & M_TUNNEL) {
          const rf = I.rflag[i];
          for (let y = CL; y < TUN_TOP; y++) d[col + (y << 8)] = B.AIR;
          d[col + (TUN_TOP << 8)] = (rf & R_CEILLAMP) ? B.LAMP : (rf & R_PORTAL) ? B.HAZARD : B.CONCRETE;
          if (rf & R_PORTAL) for (let y = TUN_TOP + 1; y < TUN_TOP + 3; y++) d[col + (y << 8)] = B.CONCRETE;
        } else {
          for (let y = CL; y <= Math.max(topY, CL); y++) d[col + (y << 8)] = B.AIR;
        }
      }
      return;
    }
    const rf = I.rflag[i];
    if (rf & R_TUNWALL) {
      for (let y = RY; y <= TUN_TOP + ((rf & R_PORTAL) ? 2 : 0); y++) d[col + (y << 8)] = B.CONCRETE;
      return;
    }
    if (m & M_SIDEWALK) { d[col + (RY << 8)] = B.SIDEWALK; return; }
    // ground cover
    if (topId === B.GRASS && topY >= SEA && topY < 95 && !(m & M_NOPROP)) {
      const r = h3(x, 7, z, this.seed);
      const f = I.roadDist[i] < 2 ? 0 : 1;
      if (f) {
        const forest = h > 47 ? 0.06 : 0.2;
        if (r < forest) d[col + ((topY + 1) << 8)] = B.TALL_GRASS;
        else if (r < forest + 0.022) d[col + ((topY + 1) << 8)] = B.FLOWER_YELLOW;
        else if (r < forest + 0.04) d[col + ((topY + 1) << 8)] = B.FLOWER_RED;
      }
    }
  }

  /** Spaghetti caves in mountain chunks: two 3D noises sampled on a 4-block lattice, trilinear interpolated. */
  caves(d, ox, oz) {
    const I = this.I;
    const maxY = Math.min(88, this.chunkMax[(oz >> 4) * CH + (ox >> 4)]);
    const ny = Math.min(24, Math.ceil(maxY / 4) + 1);
    const L = this.lattice;
    const A = this.caveA, Bn = this.caveB;
    for (let ly = 0; ly < ny; ly++) for (let lz = 0; lz < 5; lz++) for (let lx = 0; lx < 5; lx++) {
      const wx = ox + lx * 4, wy = ly * 4, wz = oz + lz * 4;
      const k = ((ly * 5 + lz) * 5 + lx) * 2;
      L[k] = A.noise3(wx / 34, wy / 22, wz / 34);
      L[k + 1] = Bn.noise3(wx / 34 + 50, wy / 22, wz / 34);
    }
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const x = ox + lx, z = oz + lz;
        const i = z * N + x;
        if (I.mask[i] & (M_ROAD | M_SHOULDER | M_CITY) || I.rflag[i] || I.roadDist[i] < 6) continue;
        if (x >= 126 && x < 202 && z >= 24 && z < 56) continue; // keep the mine massif intact
        const h = I.hgt[i];
        const yTop = Math.min(h - 7, maxY - 1);
        if (yTop < 6) continue;
        const gx = lx >> 2, fx = (lx & 3) / 4, gz = lz >> 2, fz = (lz & 3) / 4;
        const col = lx + (lz << 4);
        for (let y = 5; y <= yTop; y++) {
          const gy = y >> 2, fy = (y & 3) / 4;
          if (gy + 1 >= ny) break;
          let v1 = 0, v2 = 0;
          for (let c = 0; c < 8; c++) {
            const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
            const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
            const k = (((gy + dy) * 5 + (gz + dz)) * 5 + (gx + dx)) * 2;
            v1 += L[k] * w; v2 += L[k + 1] * w;
          }
          if (v1 * v1 + v2 * v2 < 0.0065) {
            const k = col + (y << 8);
            const cur = d[k];
            if (cur === B.STONE || cur === B.DIRT || cur === B.GRAVEL || cur === B.SAND || cur === B.SANDSTONE) d[k] = y < 11 ? B.WATER : B.AIR;
          }
        }
      }
    }
  }

  /** Ore veins (random walks) owned by this chunk; deeper = rarer. Only replaces stone. */
  ores(d, cx, cz) {
    const rng = makeRng((Math.imul(cx + 1, 73856093) ^ Math.imul(cz + 1, 19349663) ^ Math.imul(this.seed, 83492791)) >>> 0);
    const maxH = this.chunkMax[cz * CH + cx];
    const kinds = [
      [B.COAL_ORE, 14, 5, Math.max(12, maxH - 3), 4, 9],
      [B.IRON_ORE, 9, 4, Math.min(52, maxH - 4), 3, 6],
      [B.GOLD_ORE, 3, 3, 30, 2, 5],
      [B.DIAMOND_ORE, rng() < 0.55 ? 2 : 1, 2, 15, 1, 4],
    ];
    for (const [id, count, y0, y1, s0, s1] of kinds) {
      for (let n = 0; n < count; n++) {
        let x = Math.floor(rng() * 16), z = Math.floor(rng() * 16);
        let y = y0 + Math.floor(rng() * Math.max(1, y1 - y0));
        // coal is biased toward shallow depths
        if (id === B.COAL_ORE && rng() < 0.5) y = Math.max(y0, y1 - Math.floor(rng() * 14));
        const size = s0 + Math.floor(rng() * (s1 - s0 + 1));
        for (let k = 0; k < size; k++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < 95) {
            const idx = x + (z << 4) + (y << 8);
            if (d[idx] === B.STONE) d[idx] = id;
          }
          const r = rng();
          if (r < 0.33) x += rng() < 0.5 ? 1 : -1; else if (r < 0.66) z += rng() < 0.5 ? 1 : -1; else y += rng() < 0.5 ? 1 : -1;
        }
      }
    }
  }
}
