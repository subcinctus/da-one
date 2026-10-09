// Raw terrain heightmap for the whole 512x512 map (before roads are blended in).
// Produces float heights (standing height = top solid block + 1) and water-body tags.
import { Noise } from '../core/noise.js';
import {
  N, CL, CITY_X0, CITY_X1, RING, MINE, LAKE, RIVER, OUTFLOW, BEACH, PORT, FARM, clamp, lerp, smooth, polyDist,
} from './gen_const.js';

export const WB_NONE = 0, WB_OCEAN = 1, WB_LAKE = 2, WB_RIVER = 3;

/** Distance from (x,z) to the axis-aligned rect [x0,x1) x [z0,z1) (0 inside). */
export function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : x > x1 - 1 ? x - (x1 - 1) : 0;
  const dz = z < z0 ? z0 - z : z > z1 - 1 ? z - (z1 - 1) : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Build the raw terrain. Returns { raw: Float32Array, wb: Uint8Array (water body), forest: Float32Array, coast: Float32Array }.
 * raw[i] = float standing height at column i = z*512+x.
 */
export function buildTerrain(seed) {
  const n1 = new Noise(seed * 7 + 11);
  const n2 = new Noise(seed * 13 + 3);
  const n3 = new Noise(seed * 29 + 101);
  const raw = new Float32Array(N * N);
  const wb = new Uint8Array(N * N);
  const forest = new Float32Array(N * N);
  const coast = new Float32Array(N * N);

  // Low-frequency fields on a 4-block lattice (129x129), bilinearly interpolated per column.
  const G = 4, GN = N / G + 1;
  const lfHills = new Float32Array(GN * GN), lfRidge = new Float32Array(GN * GN);
  const lfForest = new Float32Array(GN * GN), lfCoast = new Float32Array(GN * GN);
  for (let gz = 0; gz < GN; gz++) {
    for (let gx = 0; gx < GN; gx++) {
      const x = gx * G, z = gz * G, k = gz * GN + gx;
      lfHills[k] = 33 + 10 * n1.fbm2(x / 130, z / 130, 4) + 5.5 * n2.noise2(x / 41, z / 41);
      lfRidge[k] = 1 - Math.abs(n2.noise2(x / 74, z / 52));
      lfForest[k] = n3.fbm2(x / 95 + 31.1, z / 95 - 7.7, 3) + 0.25 * n1.noise2(x / 23, z / 23);
      lfCoast[k] = 4.5 * n2.noise2(x / 47, z / 47) + 2 * n3.noise2(x / 17, z / 17);
    }
  }
  const zzNoise = new Float32Array(N);
  for (let x = 0; x < N; x++) zzNoise[x] = 9 * n1.noise2(x / 63, 17.3);
  const bil = (arr, x, z) => {
    const gx = x >> 2, gz = z >> 2, fx = (x & 3) / 4, fz = (z & 3) / 4;
    const k = gz * GN + gx;
    const a = arr[k] + (arr[k + 1] - arr[k]) * fx;
    const b = arr[k + GN] + (arr[k + GN + 1] - arr[k + GN]) * fx;
    return a + (b - a) * fz;
  };
  const riverBox = [10, 0, 150, 290];
  const beachWl = new Float32Array(N);
  for (let z = 0; z < N; z++) beachWl[z] = BEACH.waterX + 2.5 * n1.noise2(z / 31, 3.3) + 1.2 * n3.noise2(z / 9, 1.7);

  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const dc = rectDist(x, z, CITY_X0, CITY_X0, CITY_X1, CITY_X1);
      coast[i] = 99;
      if (dc <= 2) { raw[i] = CL; forest[i] = -1; continue; } // city interior: perfectly flat
      // ---------------- rolling hills ----------------
      let h = bil(lfHills, x, z) + 1.6 * n3.noise2(x / 13, z / 13);
      // gentle meadow plateaus: compress the low parts
      if (h < 30) h = 30 - (30 - h) * 0.6;

      // ---------------- northern mountain range ----------------
      const spur = 30 * Math.exp(-(((x - 352) / 24) ** 2)) + 4 * Math.exp(-(((x - 230) / 34) ** 2));
      const zz = z - spur - zzNoise[x];
      const mN = smooth(84, 34, zz);
      if (mN > 0) {
        const r1 = bil(lfRidge, x, z);
        const r2 = 1 - Math.abs(n3.noise2(x / 27 + 7.7, z / 27));
        const m = 44 + 36 * r1 * r1 + 10 * r2 * r1 + 3 * n1.noise2(x / 9, z / 9);
        h = lerp(h, m, mN);
      }
      // massif around the mine (rock above the galleries and cavern)
      const dm = rectDist(x, z, 124, 22, 204, 56);
      if (dm < 26) h = Math.max(h, lerp(58 + 6 * n3.noise2(x / 15, z / 15), h, smooth(0, 26, dm)));

      // valley corridor along the north ring road (the eastern spur keeps its tunnel)
      const dRing = Math.abs(z - RING.z0);
      if (dRing < 34 && (x < 326 || x > 384)) h = lerp(Math.min(h, 33), h, smooth(8, 34, dRing));

      // ---------------- city flattening ----------------
      h = lerp(CL, h, smooth(2, 44, dc));

      // ---------------- ocean ring + coasts ----------------
      let de = Math.min(x, z, N - 1 - x, N - 1 - z) + bil(lfCoast, x, z);
      let sea = smooth(9, 35, de);
      h = lerp(11.5, h, sea);

      // east coast: beach (z in beach range) and port (flat quay)
      if (x >= 404) {
        const wBeach = smooth(BEACH.z0 - 14, BEACH.z0 + 4, z) * smooth(BEACH.z1 + 10, BEACH.z1 - 2, z);
        if (wBeach > 0) {
          const wl = beachWl[z];
          let bh;
          if (x < 439) bh = CL;
          else {
            const t = (x - 444) / (wl - 444);
            bh = x < 444 ? CL : t <= 1 ? CL - 4 * t + 0.2 : 24 - (x - wl) * 0.42;
            bh = Math.max(bh, 11.5);
          }
          h = lerp(h, bh, wBeach);
          de = Math.min(de, lerp(de, wl - x + 22, wBeach));
        }
        const wPort = smooth(PORT.z0 - 8, PORT.z0, z) * smooth(PORT.z1 + 6, PORT.z1 - 2, z);
        if (wPort > 0) {
          const ph = x < PORT.quayX ? CL : 12;
          h = lerp(h, ph, wPort);
          if (x >= PORT.quayX) de = Math.min(de, lerp(de, 0, wPort));
        }
      }

      // ---------------- river (from the north-west mountains into the lake) ----------------
      const dR = x >= riverBox[0] && x < riverBox[2] && z >= riverBox[1] && z < riverBox[3] ? polyDist(x, z, RIVER) : 99;
      if (dR < 40) {
        const width = 3.2 + 1.4 * smooth(20, 240, z);
        const valley = 18.6 + Math.max(0, dR - width) * (1.25 + 0.5 * smooth(150, 40, z));
        if (valley < h) { h = valley; if (dR < width + 1.5) wb[i] = WB_RIVER; }
      }
      // ---------------- Mirror Lake (the west ring road crosses it on a bridge) ----------------
      const lx = (x - LAKE.cx) / LAKE.rx, lz = (z - LAKE.cz) / LAKE.rz;
      if (lx * lx + lz * lz < 7.5) {
        const ang = Math.atan2(lz, lx);
        const wob = 1 + 0.12 * Math.sin(ang * 3 + seed) + 0.07 * Math.sin(ang * 5 + 1.3);
        const el = Math.sqrt(lx * lx + lz * lz) / wob;
        if (el < 2.2) {
          const bed = el < 1 ? 15.5 + 7.5 * el * el : 23 + (el - 1) * LAKE.rx * 1.05;
          if (bed < h) { h = bed; if (el < 1.02) wb[i] = WB_LAKE; }
        }
      }
      // outflow to the western ocean
      const dO = x < 80 && z > 250 && z < 340 ? polyDist(x, z, OUTFLOW) : 99;
      if (dO < 24) {
        const valley = 19 + Math.max(0, dO - 3) * 1.6;
        if (valley < h) { h = valley; if (dO < 4) wb[i] = WB_RIVER; }
      }

      // ---------------- farm plateau (south) ----------------
      const df = rectDist(x, z, FARM.x0, FARM.z0, FARM.x1, FARM.z1 - 6);
      if (df < 16) h = lerp(CL, h, smooth(0, 16, df));

      // ---------------- mine camp clearing next to the mine road ----------------
      const dcamp = rectDist(x, z, MINE.roadX + 4, 51, MINE.roadX + 16, 64);
      if (dcamp < 6) h = lerp(CL, h, smooth(0, 6, dcamp));

      if (h < 24 && wb[i] === 0) wb[i] = WB_OCEAN;
      raw[i] = clamp(h, 2, 93);
      coast[i] = de;
      // forest density (positive = forest)
      forest[i] = bil(lfForest, x, z);
    }
  }
  return { raw, wb, forest, coast, noise: n1, noise2: n2, noise3: n3 };
}

