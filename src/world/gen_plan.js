// Builds the city plan (ARCHITECTURE.md §4.1): road graph, lots, POIs, parking spots + 512x512 typed-array rasters
// (surface height, road/sidewalk/water masks, lot index, district, map colour) answering every query in O(1).
import { B } from './blocks.js';
import { WORLD } from '../core/config.js';
import { buildRoadNetwork, buildLots, resolvePois } from './gen_layout.js';
import { buildTerrain, WB_LAKE, WB_RIVER, rectDist } from './gen_terrain.js';
import {
  N, CL, RY, SEA, M_ROAD, M_SIDEWALK, M_WATER, M_CITY, M_TUNNEL, M_BRIDGE, M_SHOULDER, M_NOPROP,
  R_TUNWALL, R_PILLAR, R_RAIL, R_CEILLAMP, R_PORTAL, S_GRASS, S_SAND, S_SNOW, S_STONE, S_GRAVEL, S_DIRT, S_CITY,
  CITY_X0, CITY_X1, DISTRICTS, DIST, DGRID, GRID, PORT, FARM, BEACH, LAKE, MINE, RING, h2, h3, clamp, lerp, smooth,
} from './gen_const.js';
import { BP, shade, mix } from './gen_build_core.js';
import {
  buildTower, buildMidrise, buildWalkup, buildHouse, buildSafehouse, buildHospital, buildPolice, buildGunshop, buildHardware, buildGarage,
} from './gen_build_city.js';
import {
  buildCentralPark, buildPocketPark, buildPlaza, buildMarket, buildParking, buildWarehouse, buildFactory, buildPortYard,
  buildContainerYard, buildHelipadLot, buildQuay, buildFarmhouse, buildBarn, buildField, buildFarmyard, buildSite,
} from './gen_build_misc.js';
import { buildMine, buildMineCamp, buildBeach, buildPier, buildHillSign, buildBillboards, buildTurbines, buildRadioMast } from './gen_structures.js';
import {
  feat, binFeatures, featureMapColor, featureMapRadius, F_OAK, F_BIGOAK, F_SPRUCE, F_PALM, F_BUSH, F_ROCK, F_LAMP, F_UMBRELLA, F_STREETTREE,
} from './gen_features.js';

const NN = N * N;
const CH = N >> 4; // chunks per axis (32)
const inCity = (x, z) => x >= CITY_X0 && x < CITY_X1 && z >= CITY_X0 && z < CITY_X1;
const inPortLand = (x, z) => x >= PORT.x0 && x < PORT.quayX && z >= PORT.z0 && z < PORT.z1;

function buildBlueprint(lot, seed, P) {
  const bp = new BP(lot, seed, P);
  switch (lot.style) {
    case 'tower': buildTower(bp); break;
    case 'midrise': buildMidrise(bp, false); break;
    case 'hotel': buildMidrise(bp, true); break;
    case 'walkup': buildWalkup(bp); break;
    case 'house': buildHouse(bp); break;
    case 'safehouse': buildSafehouse(bp); break;
    case 'hospital': buildHospital(bp); break;
    case 'police': buildPolice(bp); break;
    case 'gunshop': buildGunshop(bp); break;
    case 'hardware': buildHardware(bp); break;
    case 'garage': buildGarage(bp); break;
    case 'central': buildCentralPark(bp); break;
    case 'pocket': buildPocketPark(bp); break;
    case 'plaza': buildPlaza(bp); break;
    case 'market': buildMarket(bp); break;
    case 'lot': buildParking(bp); break;
    case 'warehouse': buildWarehouse(bp); break;
    case 'factory': buildFactory(bp); break;
    case 'portyard': buildPortYard(bp); break;
    case 'containers': buildContainerYard(bp); break;
    case 'helipad': buildHelipadLot(bp); break;
    case 'quay': buildQuay(bp); break;
    case 'farmhouse': buildFarmhouse(bp); break;
    case 'barn': buildBarn(bp); break;
    case 'field': buildField(bp); break;
    case 'farmyard': buildFarmyard(bp); break;
    case 'site': buildSite(bp); break;
    default: bp.fill(lot.x0, RY, lot.z0, lot.x1, RY + 1, lot.z1, B.GRASS); break;
  }
  return bp;
}

/** Build the complete plan. Returns { plan, internal } where internal holds rasters for chunk generation. */
export function buildPlan(seed) {
  const T0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const timing = {};
  let tl = T0;
  const lap = (k) => { const t = (typeof performance !== 'undefined' ? performance : Date).now(); timing[k] = Math.round(t - tl); tl = t; };

  const { nodes, roads } = buildRoadNetwork();
  const { lots, poiSpecs } = buildLots(seed);
  const pois = resolvePois(poiSpecs);
  lap('layout');
  const T = buildTerrain(seed);
  lap('terrain');

  const mask = new Uint8Array(NN);
  const rflag = new Uint8Array(NN);
  const top = new Uint8Array(NN);
  const roadIdx = new Int16Array(NN).fill(-1);
  const roadBest = new Uint8Array(NN).fill(255);
  const roadDist = new Uint8Array(NN).fill(255);
  const hgt = new Uint8Array(NN);
  const surf = new Uint8Array(NN);
  const lotIdx = new Int16Array(NN).fill(-1);
  const distIdx = new Uint8Array(NN);
  const color = new Uint32Array(NN);

  // ------------------------------------------------------------------ road geometry
  const geo = roads.map((r) => {
    const A = nodes[r.a], Bn = nodes[r.b];
    const vertical = A.x === Bn.x;
    const aFirst = vertical ? A.z <= Bn.z : A.x <= Bn.x;
    const n0 = aFirst ? A : Bn, n1 = aFirst ? Bn : A;
    const extOf = (n) => {
      let e = 0;
      for (const ri of n.edges) {
        if (ri === r.id) continue;
        const o = roads[ri];
        const ov = nodes[o.a].x === nodes[o.b].x;
        if (ov !== vertical) e = Math.max(e, o.width / 2);
      }
      return e;
    };
    return {
      r, vertical, c: vertical ? A.x : A.z, s0: vertical ? n0.z : n0.x, s1: vertical ? n1.z : n1.x, hw: r.width / 2,
      e0: extOf(n0), e1: extOf(n1), n0, n1, city: r.kind === 'street' || r.kind === 'avenue', mode: null,
    };
  });
  const cellOf = (g, s, a) => (g.vertical ? s * N + a : a * N + s);
  const okCell = (g, s, a) => s >= 0 && s < N && a >= 0 && a < N;

  // sidewalks (city roads), extended around the corners
  for (const g of geo) {
    if (!g.city) continue;
    for (let s = g.s0 - g.e0 - 3; s < g.s1 + g.e1 + 3; s++) {
      for (let a = g.c - g.hw - 3; a < g.c + g.hw + 3; a++) {
        if (a >= g.c - g.hw && a < g.c + g.hw) continue;
        if (!okCell(g, s, a)) continue;
        mask[cellOf(g, s, a)] |= M_SIDEWALK;
      }
    }
  }
  // asphalt
  for (const g of geo) {
    for (let s = g.s0 - g.e0; s < g.s1 + g.e1; s++) {
      for (let a = g.c - g.hw; a < g.c + g.hw; a++) {
        if (!okCell(g, s, a)) continue;
        const i = cellOf(g, s, a);
        mask[i] |= M_ROAD;
        const off = Math.abs(a + 0.5 - g.c);
        const q = Math.min(254, Math.round(off * 4));
        if (q < roadBest[i]) { roadBest[i] = q; roadIdx[i] = g.r.id; }
      }
    }
  }
  for (let i = 0; i < NN; i++) {
    if (mask[i] & M_ROAD) { mask[i] &= ~M_SIDEWALK; top[i] = B.ASPHALT; }
    else if (mask[i] & M_SIDEWALK) top[i] = B.SIDEWALK;
  }
  // shoulders for highways / country roads
  for (const g of geo) {
    if (g.city) continue;
    for (let s = g.s0 - g.e0; s < g.s1 + g.e1; s++) {
      for (const a of [g.c - g.hw - 1, g.c + g.hw]) {
        if (!okCell(g, s, a)) continue;
        const i = cellOf(g, s, a);
        const x = g.vertical ? a : s, z = g.vertical ? s : a;
        if (mask[i] & (M_ROAD | M_SIDEWALK) || inCity(x, z)) continue;
        mask[i] |= M_SHOULDER;
        top[i] = B.GRAVEL;
      }
    }
  }
  // paint: centre lines, lane dashes, edge lines, zebra crossings, stop lines
  for (const g of geo) {
    const deg0 = g.n0.edges.length, deg1 = g.n1.edges.length;
    const city0 = deg0 >= 3 && inCity(g.n0.x, g.n0.z), city1 = deg1 >= 3 && inCity(g.n1.x, g.n1.z);
    for (let s = g.s0 - g.e0; s < g.s1 + g.e1; s++) {
      const sc = s + 0.5, t0 = sc - g.s0, t1 = g.s1 - sc;
      if ((deg0 >= 2 && t0 < g.e0) || (deg1 >= 2 && t1 < g.e1)) continue;
      let zone = 0, toward = 0;
      if (city0 && t0 < g.e0 + 3) zone = 1; else if (city0 && t0 < g.e0 + 4) { zone = 2; toward = 0; }
      if (city1 && t1 < g.e1 + 3) zone = 1; else if (city1 && t1 < g.e1 + 4) { zone = 2; toward = 1; }
      for (let a = g.c - g.hw; a < g.c + g.hw; a++) {
        if (!okCell(g, s, a)) continue;
        const i = cellOf(g, s, a);
        const off = a - g.c;
        let id = B.ASPHALT;
        if (zone === 1) { if (((a - (g.c - g.hw)) & 1) === 0) id = B.ROAD_LINE_WHITE; }
        else if (zone === 2) {
          const right = g.vertical ? (toward === 1 ? a < g.c : a >= g.c) : (toward === 1 ? a >= g.c : a < g.c);
          if (right) id = B.ROAD_LINE_WHITE; else if (off === -1 || off === 0) id = B.ROAD_LINE_YELLOW;
        } else if (off === -1 || off === 0) id = B.ROAD_LINE_YELLOW;
        else if (g.r.lanes === 2 && (off === -4 || off === 3) && ((s % 6) + 6) % 6 < 3) id = B.ROAD_LINE_WHITE;
        else if (!g.city && (off === -g.hw || off === g.hw - 1)) id = B.ROAD_LINE_WHITE;
        top[i] = id;
      }
    }
  }
  lap('roads');

  // ------------------------------------------------------------------ tunnels / bridges / terrain blending
  const raw = T.raw, wb = T.wb;
  const nearJunction = (g, s) => (g.n0.edges.length >= 3 && Math.abs(s + 0.5 - g.s0) < g.e0 + 10) || (g.n1.edges.length >= 3 && Math.abs(g.s1 - s - 0.5) < g.e1 + 10);
  for (const g of geo) {
    if (g.city) continue;
    const sA = g.s0 - g.e0, sB = g.s1 + g.e1, len = sB - sA;
    const mode = new Uint8Array(len);
    for (let k = 0; k < len; k++) {
      const s = sA + k;
      let mx = -1e9, mn = 1e9, water = false, city = false;
      for (let a = g.c - g.hw - 1; a < g.c + g.hw + 1; a++) {
        if (!okCell(g, s, a)) continue;
        const i = cellOf(g, s, a);
        const x = g.vertical ? a : s, z = g.vertical ? s : a;
        if (inCity(x, z) || inPortLand(x, z)) city = true;
        const r = raw[i];
        if (r > mx) mx = r; if (r < mn) mn = r;
        if (wb[i]) water = true;
      }
      if (city) mode[k] = 0;
      else if (water || mn < 24.5) mode[k] = 2;
      else if (mx >= 41 && g.r.kind === 'highway' && !nearJunction(g, s)) mode[k] = 1;
    }
    // tunnels shorter than 10 become cuttings; bridges get 2 extra stations of abutment
    for (let k = 0; k < len;) {
      if (mode[k] !== 1) { k++; continue; }
      let e = k; while (e < len && mode[e] === 1) e++;
      if (e - k < 10) for (let j = k; j < e; j++) mode[j] = 0;
      k = e;
    }
    const br = mode.slice();
    for (let k = 0; k < len; k++) if (br[k] === 2) for (let j = Math.max(0, k - 2); j <= Math.min(len - 1, k + 2); j++) if (mode[j] === 0) mode[j] = 3;
    for (let k = 0; k < len; k++) if (mode[k] === 3) mode[k] = 2;
    g.mode = mode; g.sA = sA;
    for (let k = 0; k < len; k++) {
      const s = sA + k, md = mode[k];
      if (md === 1) {
        const portal = (k === 0 || mode[k - 1] !== 1) || (k === len - 1 || mode[k + 1] !== 1);
        for (let a = g.c - g.hw - 2; a <= g.c + g.hw + 1; a++) {
          if (!okCell(g, s, a)) continue;
          const i = cellOf(g, s, a);
          if (a === g.c - g.hw - 2 || a === g.c + g.hw + 1) { if (!(mask[i] & (M_ROAD | M_SHOULDER))) rflag[i] |= R_TUNWALL; }
          else mask[i] |= M_TUNNEL;
          if (portal) rflag[i] |= R_PORTAL;
          if (a === g.c - 1 && (s % 8) === 0) rflag[i] |= R_CEILLAMP;
        }
      } else if (md === 2) {
        for (let a = g.c - g.hw - 1; a <= g.c + g.hw; a++) {
          if (!okCell(g, s, a)) continue;
          const i = cellOf(g, s, a);
          if (!(mask[i] & (M_ROAD | M_SHOULDER))) continue;
          mask[i] |= M_BRIDGE;
          if ((a === g.c - g.hw - 1 || a === g.c + g.hw) && !(mask[i] & M_ROAD)) rflag[i] |= R_RAIL;
          const sm = ((s % 14) + 14) % 14;
          if (sm < 2 && ((a >= g.c - g.hw && a < g.c - g.hw + 2) || (a >= g.c + g.hw - 2 && a < g.c + g.hw))) rflag[i] |= R_PILLAR;
          if (sm < 2 && a >= g.c - 1 && a <= g.c) rflag[i] |= R_PILLAR;
        }
      } else {
        // blend the terrain toward road level on both sides
        const reach = g.hw + 1 + 14;
        for (let a = g.c - reach; a < g.c + reach; a++) {
          if (!okCell(g, s, a)) continue;
          const off = a < g.c ? g.c - 1 - a : a - g.c;
          const d = Math.max(0, off - g.hw);
          const i = cellOf(g, s, a);
          if (d < roadDist[i]) roadDist[i] = d;
        }
      }
    }
  }
  // round blend around countryside junctions / bends
  for (const nd of nodes) {
    if (inCity(nd.x, nd.z) || nd.edges.length < 2) continue;
    const R = 6 + 1 + 14;
    for (let z = nd.z - R; z <= nd.z + R; z++) for (let x = nd.x - R; x <= nd.x + R; x++) {
      if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const d = Math.max(0, Math.round(Math.hypot(x + 0.5 - nd.x, z + 0.5 - nd.z) - 7));
      const i = z * N + x;
      if (d < roadDist[i]) roadDist[i] = d;
    }
  }
  lap('roadmodes');

  // lots raster + city mask
  for (const lot of lots) {
    for (let z = lot.z0; z < lot.z1; z++) for (let x = lot.x0; x < lot.x1; x++) {
      const i = z * N + x;
      lotIdx[i] = lot.id;
      mask[i] |= M_CITY;
      if (!top[i]) top[i] = B.GRASS;
    }
  }
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      if (inCity(x, z) || inPortLand(x, z)) {
        mask[i] |= M_CITY;
        if (!top[i]) top[i] = inPortLand(x, z) ? B.CONCRETE : B.GRASS;
      }
    }
  }

  // final heights
  for (let i = 0; i < NN; i++) {
    if (mask[i] & M_CITY) { hgt[i] = CL; continue; }
    let h = raw[i];
    const rd = roadDist[i];
    if (rd < 15 && !wb[i] && h >= 23.5) h = lerp(CL, h, smooth(0, 14, rd));
    hgt[i] = clamp(Math.round(h), 2, 93);
  }
  for (let i = 0; i < NN; i++) {
    const m = mask[i];
    if ((m & (M_ROAD | M_SHOULDER)) && !(m & (M_TUNNEL | M_BRIDGE | M_CITY))) hgt[i] = CL;
  }
  // water + surfaces
  const n3 = T.noise3;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const m = mask[i];
      if (m & M_CITY) { surf[i] = S_CITY; continue; }
      const h = hgt[i];
      if (h <= SEA - 1 && !(m & (M_ROAD | M_SHOULDER))) {
        mask[i] |= M_WATER;
        surf[i] = (wb[i] === WB_LAKE || wb[i] === WB_RIVER) ? (h < 19 ? S_GRAVEL : S_SAND) : (h < 16 ? S_GRAVEL : S_SAND);
        continue;
      }
      const hl = hgt[z * N + Math.max(0, x - 1)], hr = hgt[z * N + Math.min(N - 1, x + 1)];
      const hu = hgt[Math.max(0, z - 1) * N + x], hd = hgt[Math.min(N - 1, z + 1) * N + x];
      const slope = Math.max(Math.abs(h - hl), Math.abs(h - hr), Math.abs(h - hu), Math.abs(h - hd));
      const beachZone = x >= 436 && z >= BEACH.z0 - 8 && z < BEACH.z1 + 4;
      const snowLine = 71 + 3 * n3.noise2(x / 23, z / 23);
      let s = S_GRASS;
      if (beachZone && h <= CL) s = S_SAND;
      else if (h <= 25 && (T.coast[i] < 42 || wb[i])) s = S_SAND;
      else if (h <= 25 && h2(x >> 1, z >> 1, seed + 3) < 0.5 && (hl < 24 || hr < 24 || hu < 24 || hd < 24)) s = S_SAND;
      else if (h >= snowLine) s = slope >= 4 ? S_STONE : S_SNOW;
      else if (slope >= 3 || (h >= 58 && slope >= 2)) s = S_STONE;
      else if (h >= 54 && h2(x, z, seed + 5) < (h - 54) / 22) s = S_STONE;
      else if (T.forest[i] > 0.3 && h2(x, z, seed + 6) < 0.12) s = S_DIRT;
      surf[i] = s;
    }
  }
  lap('heights');

  // ------------------------------------------------------------------ plan accessor for builders
  const P = {
    heightAt: (x, z) => (x < 0 || z < 0 || x >= N || z >= N ? 12 : hgt[z * N + x]),
    isRoad: (x, z) => x >= 0 && z >= 0 && x < N && z < N && !!(mask[z * N + x] & M_ROAD),
    isSidewalk: (x, z) => x >= 0 && z >= 0 && x < N && z < N && !!(mask[z * N + x] & M_SIDEWALK),
    isCityOrLot: (x, z) => x < 0 || z < 0 || x >= N || z >= N || !!(mask[z * N + x] & (M_CITY | M_WATER | M_SHOULDER)),
  };

  // ------------------------------------------------------------------ blueprints (lots + structures)
  const bps = lots.map((lot) => buildBlueprint(lot, seed, P));
  const mine = buildMine(seed, P);
  const structures = [mine, buildMineCamp(seed, P), buildBeach(seed, P), buildPier(seed, P), buildHillSign(seed, P), buildBillboards(seed, P), buildTurbines(seed, P), buildRadioMast(seed, P)];
  const allBps = bps.concat(structures);
  const chunkBps = Array.from({ length: CH * CH }, () => []);
  for (const bp of allBps) {
    const [x0, z0, x1, z1] = bp.bbox;
    for (let cz = Math.max(0, z0 >> 4); cz <= Math.min(CH - 1, (z1 - 1) >> 4); cz++) {
      for (let cx = Math.max(0, x0 >> 4); cx <= Math.min(CH - 1, (x1 - 1) >> 4); cx++) chunkBps[cz * CH + cx].push(bp);
    }
  }
  const parkingSpots = [];
  const rooftops = [];
  for (const bp of allBps) {
    if (bp.roofPoint) rooftops.push(bp.roofPoint);
    for (const r of bp.noprop) for (let z = r[1]; z < r[3]; z++) for (let x = r[0]; x < r[2]; x++) if (x >= 0 && z >= 0 && x < N && z < N) mask[z * N + x] |= M_NOPROP;
    for (const s of bp.spots) parkingSpots.push(s);
    for (const r of bp.wetRects) for (let z = r[1]; z < r[3]; z++) for (let x = r[0]; x < r[2]; x++) if (x >= 0 && z >= 0 && x < N && z < N) mask[z * N + x] |= M_WATER;
    if (bp.lot && bp.lot.id >= 0) {
      bp.lot.roofY = bp.roofY;
      const built = ['tower', 'building', 'shop', 'house', 'industrial'].includes(bp.lot.type);
      bp.lot.height = built ? Math.max(0, bp.roofY - CL) : 0;
    }
  }
  // per-column roof standing height (from the blueprints' roof rects)
  const roofH = new Uint8Array(NN);
  for (const bp of allBps) {
    for (const r of bp.map) {
      if (r.kind !== 'roof') continue;
      const v = clamp(CL + Math.round(r.h), 0, 95);
      for (let z = Math.max(0, r.z0); z < Math.min(N, r.z1); z++) for (let x = Math.max(0, r.x0); x < Math.min(N, r.x1); x++) if (v > roofH[z * N + x]) roofH[z * N + x] = v;
    }
  }
  lap('blueprints');

  // ------------------------------------------------------------------ features
  const features = [];
  // street lamps + street trees along city roads (curb column, keeps the sidewalk centre clear)
  for (const g of geo) {
    if (!g.city) continue;
    for (const side of [-1, 1]) {
      const a = side < 0 ? g.c - g.hw - 1 : g.c + g.hw;
      const phase = side < 0 ? 0 : 7;
      for (let s = g.s0 + g.e0 + 6 + phase; s < g.s1 - g.e1 - 5; s += 14) {
        if (!okCell(g, s, a)) continue;
        const x = g.vertical ? a : s, z = g.vertical ? s : a;
        const i = z * N + x;
        if (!(mask[i] & M_SIDEWALK) || (mask[i] & M_NOPROP)) continue;
        features.push(feat(F_LAMP, x, z, CL, 4, 0, 0));
        // street tree halfway to the next lamp
        const s2 = s + 7;
        if (s2 < g.s1 - g.e1 - 5) {
          const x2 = g.vertical ? a : s2, z2 = g.vertical ? s2 : a;
          const i2 = z2 * N + x2;
          const did = districtOfCity(x2, z2);
          const pTree = did === 'residential' ? 0.85 : did === 'bayfront' ? 0.8 : did === 'downtown' ? 0.55 : did === 'industrial' || did === 'port' ? 0.0 : 0.6;
          if ((mask[i2] & M_SIDEWALK) && !(mask[i2] & M_NOPROP) && h2(x2, z2, seed + 21) < pTree) {
            features.push(did === 'bayfront' ? feat(F_PALM, x2, z2, CL, 7 + Math.floor(h2(x2, z2, 3) * 3), 4, 4) : feat(F_STREETTREE, x2, z2, CL, 0, 0, 1));
          }
        }
      }
    }
  }
  // highway lamps (outside the shoulder) and bridge lamps (on the rails)
  for (const g of geo) {
    if (g.city || !g.mode) continue;
    for (let k = 0; k < g.mode.length; k++) {
      const s = g.sA + k;
      if (((s % 24) + 24) % 24 !== 0) continue;
      const side = ((s / 24) | 0) % 2 === 0 ? -1 : 1;
      if (g.mode[k] === 2) {
        const a = side < 0 ? g.c - g.hw - 1 : g.c + g.hw;
        if (!okCell(g, s, a)) continue;
        const x = g.vertical ? a : s, z = g.vertical ? s : a;
        if (rflag[z * N + x] & R_RAIL) features.push(feat(F_LAMP, x, z, CL, 4, 0, 0));
      } else if (g.mode[k] === 0) {
        const a = side < 0 ? g.c - g.hw - 2 : g.c + g.hw + 1;
        if (!okCell(g, s, a)) continue;
        const x = g.vertical ? a : s, z = g.vertical ? s : a;
        const i = z * N + x;
        if (mask[i] & (M_ROAD | M_SHOULDER | M_SIDEWALK | M_WATER | M_CITY) || hgt[i] < 24 || Math.abs(hgt[i] - CL) > 2) continue;
        features.push(feat(F_LAMP, x, z, hgt[i], 5, 0, 0));
      }
    }
  }
  // dilated road mask (distance <= 5 to any road / shoulder / tunnel wall) keeps foliage off the traffic lanes
  const nearRoad = new Uint8Array(NN);
  {
    const tmp = new Uint8Array(NN);
    for (let z = 0; z < N; z++) {
      let last = -99;
      for (let x = 0; x < N; x++) { if (mask[z * N + x] & (M_ROAD | M_SHOULDER) || rflag[z * N + x]) last = x; if (x - last <= 5) tmp[z * N + x] = 1; }
      last = 999;
      for (let x = N - 1; x >= 0; x--) { if (mask[z * N + x] & (M_ROAD | M_SHOULDER) || rflag[z * N + x]) last = x; if (last - x <= 5) tmp[z * N + x] = 1; }
    }
    for (let x = 0; x < N; x++) {
      let last = -99;
      for (let z = 0; z < N; z++) { if (tmp[z * N + x]) last = z; if (z - last <= 5) nearRoad[z * N + x] = 1; }
      last = 999;
      for (let z = N - 1; z >= 0; z--) { if (tmp[z * N + x]) last = z; if (last - z <= 5) nearRoad[z * N + x] = 1; }
    }
  }
  // countryside vegetation on a jittered 4x4 grid
  const forest = T.forest;
  for (let gz = 0; gz < N / 4; gz++) {
    for (let gx = 0; gx < N / 4; gx++) {
      const x = gx * 4 + Math.floor(h2(gx, gz, seed + 11) * 4);
      const z = gz * 4 + Math.floor(h2(gz, gx, seed + 12) * 4);
      const i = z * N + x;
      if (mask[i] & (M_ROAD | M_SIDEWALK | M_SHOULDER | M_CITY | M_WATER | M_NOPROP)) continue;
      if (roadDist[i] < 4 || rflag[i] || nearRoad[i]) continue;
      const h = hgt[i];
      if (h < 25 || surf[i] !== S_GRASS && surf[i] !== S_DIRT) continue;
      if (x >= 434 && z >= BEACH.z0 - 10 && z < PORT.z1) continue;
      if (rectDist(x, z, CITY_X0, CITY_X0, CITY_X1, CITY_X1) < 6) continue;
      if (rectDist(x, z, FARM.x0, FARM.z0, FARM.x1, FARM.z1) < 3) continue;
      if (rectDist(x, z, MINE.roadX + 3, 52, MINE.roadX + 17, 69) < 2) continue;
      const hl = hgt[i - 1] || h, hr = hgt[i + 1] || h, hu = hgt[i - N] || h, hd = hgt[i + N] || h;
      if (Math.max(Math.abs(h - hl), Math.abs(h - hr), Math.abs(h - hu), Math.abs(h - hd)) > 2) continue;
      const f = forest[i];
      const mountain = h > 47;
      let p = f > 0.18 ? 0.62 : f > 0.0 ? 0.2 : 0.045;
      if (mountain) p = Math.min(0.5, p + 0.1);
      if (h > 66) p *= 0.4;
      const roll = h2(gx, gz, seed + 13);
      if (roll >= p) {
        if (roll < p + 0.025 && !mountain) features.push(feat(F_BUSH, x, z, h, 1, 0, 1));
        else if (roll > 0.985) features.push(feat(F_ROCK, x, z, h, 1 + (h2(x, z, 9) < 0.3 ? 1 : 0), h2(z, x, 9) < 0.5 ? 1 : 0, 2));
        continue;
      }
      const r2 = h2(x, z, seed + 14);
      if (mountain || (f > 0.35 && r2 < 0.45)) features.push(feat(F_SPRUCE, x, z, h, 6 + Math.floor(r2 * 5), 0, 3));
      else if (r2 < 0.15 && f > 0.1) features.push(feat(F_BIGOAK, x, z, h, 6 + Math.floor(r2 * 10), 3, 3));
      else features.push(feat(F_OAK, x, z, h, 4 + Math.floor(r2 * 3), 2, 2));
    }
  }
  // beach palms + umbrellas
  for (let z = BEACH.z0 + 6; z < BEACH.z1 - 6; z += 8) {
    for (const bx of [447, 453]) {
      const x = bx + Math.floor(h2(z, bx, seed + 31) * 3);
      const zz = z + Math.floor(h2(bx, z, seed + 32) * 4);
      const i = zz * N + x;
      if (mask[i] & M_WATER || hgt[i] < 25 || (zz >= 222 && zz < 238)) continue;
      if (h2(x, zz, seed + 33) < 0.72) features.push(feat(F_PALM, x, zz, hgt[i], 6 + Math.floor(h2(x, zz, 1) * 4), Math.floor(h2(zz, x, 2) * 4), 5));
    }
    const ux = 451 + Math.floor(h2(z, 7, seed + 34) * 4), uz = z + 4;
    const ui = uz * N + ux;
    if (!(mask[ui] & M_WATER) && hgt[ui] >= 25 && !(uz >= 220 && uz < 240) && h2(ux, uz, seed + 35) < 0.6) {
      const cols = [B.WOOL_RED, B.WOOL_BLUE, B.WOOL_YELLOW, B.WOOL_GREEN, B.WOOL_ORANGE, B.WOOL_PURPLE];
      features.push(feat(F_UMBRELLA, ux, uz, hgt[ui], cols[Math.floor(h2(ux, uz, 5) * cols.length)], h2(uz, ux, 6) < 0.5 ? 1 : 0, 3));
    }
  }
  const chunkFeat = Array.from({ length: CH * CH }, () => []);
  binFeatures(features, chunkFeat);
  lap('features');

  // ------------------------------------------------------------------ districts (8x8 cells for stable regions)
  for (let cz = 0; cz < N; cz += 8) {
    for (let cx = 0; cx < N; cx += 8) {
      const x = cx + 4, z = cz + 4, i = z * N + x;
      let d = 'hills';
      const lot = lotIdx[i] >= 0 ? lots[lotIdx[i]] : null;
      if (inCity(x, z)) {
        const sx = clamp(Math.floor((x - GRID[0]) / 72), 0, 3), sz = clamp(Math.floor((z - GRID[0]) / 72), 0, 3);
        d = DGRID[sz][sx];
      } else if (lot) d = lot.district;
      else if (inPortLand(x, z) || (x >= PORT.x0 && z >= PORT.z0 && z < PORT.z1)) d = 'port';
      else if (rectDist(x, z, FARM.x0, FARM.z0, FARM.x1, FARM.z1) < 10) d = 'farm';
      else if (x >= 428 && z >= BEACH.z0 - 10 && z < BEACH.z1 + 4) d = 'beach';
      else if (Math.hypot((x - LAKE.cx) / (LAKE.rx + 14), (z - LAKE.cz) / (LAKE.rz + 14)) < 1) d = 'lake';
      else if ((mask[i] & M_WATER) && T.coast[i] < 30) d = 'ocean';
      else if (z < 70 || hgt[i] > 50) d = 'mountains';
      else if (forest[i] > 0.15) d = 'forest';
      const id = DIST[d];
      for (let zz = cz; zz < cz + 8; zz++) for (let xx = cx; xx < cx + 8; xx++) distIdx[zz * N + xx] = id;
    }
  }
  lap('districts');

  // ------------------------------------------------------------------ map colours
  buildColors({ color, mask, rflag, top, hgt, surf, forest, wb, lotIdx, allBps, features, seed });
  lap('colors');

  // ------------------------------------------------------------------ spawn + POI heights + district centres
  const safe = pois.find((p) => p.type === 'safehouse');
  const spawn = safe ? { x: safe.x, y: CL, z: safe.z, yaw: safe.yaw + Math.PI } : { x: 256.5, y: CL, z: 256.5, yaw: 0 };
  for (const p of pois) {
    const ix = Math.floor(p.x), iz = Math.floor(p.z);
    const i = iz * N + ix;
    if (!(mask[i] & M_CITY) && !(mask[i] & (M_ROAD | M_SHOULDER))) p.y = hgt[i];
  }
  const dsum = DISTRICTS.map(() => ({ x: 0, z: 0, n: 0 }));
  for (let z = 4; z < N; z += 8) for (let x = 4; x < N; x += 8) { const d = dsum[distIdx[z * N + x]]; d.x += x; d.z += z; d.n++; }
  const districts = DISTRICTS.map((d, k) => ({ id: d.id, name: d.name, x: dsum[k].n ? Math.round(dsum[k].x / dsum[k].n) : 256, z: dsum[k].n ? Math.round(dsum[k].z / dsum[k].n) : 256 }));
  // fix centres that fall outside their district (e.g. L-shaped downtown) by snapping to the nearest member cell
  for (const d of districts) {
    const id = DIST[d.id];
    if (distIdx[clamp(d.z, 0, N - 1) * N + clamp(d.x, 0, N - 1)] === id) continue;
    let best = null, bd = 1e9;
    for (let z = 4; z < N; z += 8) for (let x = 4; x < N; x += 8) {
      if (distIdx[z * N + x] !== id) continue;
      const dd = (x - d.x) ** 2 + (z - d.z) ** 2;
      if (dd < bd) { bd = dd; best = [x, z]; }
    }
    if (best) { d.x = best[0]; d.z = best[1]; }
  }

  const internal = { mask, rflag, top, roadIdx, roadDist, hgt, surf, lotIdx, distIdx, color, wb, chunkBps, chunkFeat, geo, timing, features, allBps, seed, mine, roofH };
  const plan = makePlanObject({ seed, nodes, roads, lots, pois, parkingSpots, spawn, districts, internal, mine, rooftops });
  timing.total = Math.round((typeof performance !== 'undefined' ? performance : Date).now() - T0);
  return { plan, internal };
}

function districtOfCity(x, z) {
  if (x < CITY_X0 || z < CITY_X0 || x >= CITY_X1 || z >= CITY_X1) return 'hills';
  const sx = clamp(Math.floor((x - GRID[0]) / 72), 0, 3), sz = clamp(Math.floor((z - GRID[0]) / 72), 0, 3);
  return DGRID[sz][sx];
}

// ------------------------------------------------------------------------------------------------
// Map colours (minimap / full map)
// ------------------------------------------------------------------------------------------------
function buildColors(o) {
  const { color, mask, rflag, top, hgt, surf, forest, lotIdx, allBps, features } = o;
  const mapH = new Float32Array(NN);
  // terrain
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const h = hgt[i];
      const m = mask[i];
      if (m & M_WATER) {
        const depth = clamp((SEA - h) / 11, 0, 1);
        const shallow = 0x4f9be6, deep = 0x1d4f9c;
        color[i] = mix(shallow, deep, depth);
        continue;
      }
      if (m & M_CITY) { color[i] = lotIdx[i] >= 0 ? 0xa9a69c : 0xa4a198; continue; }
      let base;
      switch (surf[i]) {
        case S_SAND: base = 0xdccf94; break;
        case S_SNOW: base = 0xf0f4f7; break;
        case S_STONE: base = mix(0x8b8b88, 0x6f6f6c, clamp((h - 40) / 40, 0, 1)); break;
        case S_GRAVEL: base = 0x8a837e; break;
        case S_DIRT: base = 0x6d5a3a; break;
        default: {
          const f = forest[i];
          base = mix(0x6aa843, 0x4f8a34, clamp((f + 0.1) * 1.4, 0, 1));
          if (h > 44) base = mix(base, 0x7c8f4a, clamp((h - 44) / 26, 0, 0.7));
        }
      }
      const hn = hgt[Math.max(0, z - 1) * N + Math.max(0, x - 1)], hs = hgt[Math.min(N - 1, z + 1) * N + Math.min(N - 1, x + 1)];
      const sh = clamp(1 + (hn - hs) * 0.065, 0.68, 1.32);
      color[i] = shade(base, sh * (0.94 + h / 520));
    }
  }
  // features (canopies)
  for (const f of features) {
    const c = featureMapColor(f);
    const r = featureMapRadius(f);
    if (!c || f.t === F_STREETTREE) continue;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r + 1) continue;
      const x = f.x + dx, z = f.z + dz;
      if (x < 0 || z < 0 || x >= N || z >= N) continue;
      const i = z * N + x;
      if (mask[i] & (M_ROAD | M_SIDEWALK | M_WATER | M_SHOULDER)) continue;
      color[i] = shade(c, 0.9 + 0.2 * ((dx + dz) < 0 ? 1 : 0) + (h3(x, 1, z, 3) - 0.5) * 0.1);
    }
  }
  // lots: ground first, then roofs ordered by height
  const put = (x, z, c) => { if (x >= 0 && z >= 0 && x < N && z < N) color[z * N + x] = c; };
  const roofs = [];
  for (const bp of allBps) {
    for (const r of bp.map) {
      if (r.kind === 'ground') for (let z = r.z0; z < r.z1; z++) for (let x = r.x0; x < r.x1; x++) put(x, z, r.color);
      else roofs.push(r);
    }
    if (bp.mapFn) bp.mapFn(put);
  }
  roofs.sort((a, b) => a.h - b.h);
  for (const r of roofs) {
    if (r.kind === 'tree') {
      for (let z = r.z0; z < r.z1; z++) for (let x = r.x0; x < r.x1; x++) {
        const cxr = (r.x0 + r.x1 - 1) / 2, czr = (r.z0 + r.z1 - 1) / 2, rad = (r.x1 - r.x0) / 2;
        if ((x - cxr) ** 2 + (z - czr) ** 2 <= rad * rad) put(x, z, shade(r.color, 0.92 + h3(x, 2, z, 4) * 0.16));
      }
      continue;
    }
    const lit = 0.9 + Math.min(0.32, r.h / 170);
    for (let z = r.z0; z < r.z1; z++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const edge = x === r.x0 || z === r.z0 || x === r.x1 - 1 || z === r.z1 - 1;
        const i = z * N + x;
        color[i] = shade(r.color, edge ? lit * 0.8 : lit);
        if (r.h + CL > mapH[i]) mapH[i] = r.h + CL;
      }
    }
  }
  // roads / sidewalks / shoulders / bridges / tunnels
  for (let i = 0; i < NN; i++) {
    const m = mask[i];
    if (m & M_ROAD) {
      const t = top[i];
      let c = t === B.ROAD_LINE_YELLOW ? 0xb59a3c : t === B.ROAD_LINE_WHITE ? 0x8a8a8e : 0x46474c;
      if (m & M_TUNNEL) c = mix(color[i], 0x2b2b30, 0.6);
      color[i] = c;
      if (!(m & M_TUNNEL)) mapH[i] = Math.max(mapH[i], CL);
    } else if (m & M_SIDEWALK) {
      color[i] = 0xb9b5ab;
    } else if (m & M_SHOULDER) {
      color[i] = (m & M_BRIDGE) ? 0xa9a9a4 : (m & M_TUNNEL) ? mix(color[i], 0x3a3a3e, 0.5) : 0x8d877e;
    } else if (rflag[i] & R_TUNWALL) {
      color[i] = mix(color[i], 0x55555a, 0.25);
    }
  }
  // building drop shadows (light from the north-west)
  const sh = new Uint8Array(NN);
  for (let z = 1; z < N; z++) {
    for (let x = 1; x < N; x++) {
      const i = z * N + x;
      const base = Math.max(mapH[i], (mask[i] & M_CITY) || (mask[i] & (M_ROAD | M_SIDEWALK)) ? CL : 0);
      if (!base) continue;
      for (let j = 1; j <= 7; j++) {
        if (x - j < 0 || z - j < 0) break;
        if (mapH[(z - j) * N + (x - j)] > base + j * 4) { sh[i] = 1; break; }
      }
    }
  }
  for (let i = 0; i < NN; i++) if (sh[i]) color[i] = shade(color[i], 0.74);
}

// ------------------------------------------------------------------------------------------------
// Public plan object (contract §4.1)
// ------------------------------------------------------------------------------------------------
function makePlanObject(o) {
  const { internal } = o;
  const { mask, hgt, lotIdx, distIdx, color, roadIdx, top, roofH } = internal;
  const nodes = o.nodes, roads = o.roads, lots = o.lots, pois = o.pois;
  const districtObjs = DISTRICTS.map((d) => ({ id: d.id, name: d.name }));
  // node bins for nearestNode
  const BIN = 32, NB = N / BIN;
  const bins = Array.from({ length: NB * NB }, () => []);
  for (const nd of nodes) bins[clamp(Math.floor(nd.z / BIN), 0, NB - 1) * NB + clamp(Math.floor(nd.x / BIN), 0, NB - 1)].push(nd);
  const byType = new Map();
  for (const p of pois) { if (!byType.has(p.type)) byType.set(p.type, []); byType.get(p.type).push(p); }
  const ok = (x, z) => x >= 0 && z >= 0 && x < N && z < N;
  const cell = (x, z) => (Math.floor(z) * N + Math.floor(x));

  const plan = {
    seed: o.seed, sizeX: N, sizeZ: N,
    spawn: o.spawn,
    sidewalkWidth: 3,
    nodes, roads, lots, pois,
    parkingSpots: o.parkingSpots,
    cityBounds: { x0: CITY_X0, z0: CITY_X0, x1: CITY_X1, z1: CITY_X1 },
    /** Rooftop standing points reachable on foot through interior stairwells: [{x, y, z, lot}]. */
    rooftops: o.rooftops || [],
    districts: o.districts,
    ring: { ...RING },
    mine: o.mine ? {
      entrance: { x: MINE.roadX + 0.5, y: CL, z: MINE.roadEndZ + 0.5 },
      cavern: { x: MINE.cavern.cx + 0.5, y: MINE.cavern.floorY + 1, z: MINE.cavern.cz + 0.5, rx: MINE.cavern.rx, rz: MINE.cavern.rz },
      ores: o.mine.ores.map((q) => ({ ...q })),
    } : null,
    /** Standing height of the terrain/street (bridges/tunnels/sidewalks = street level; water = water surface 24). */
    surfaceY(x, z) {
      if (!ok(x, z)) return SEA;
      const i = cell(x, z), m = mask[i];
      if (m & (M_ROAD | M_SHOULDER | M_SIDEWALK | M_CITY)) return CL;
      if (m & M_WATER) return SEA;
      return hgt[i];
    },
    /** Raw terrain top (standing height of the ground column, ignores water and road decks). */
    heightAt(x, z) { return ok(x, z) ? hgt[cell(x, z)] : 12; },
    isRoad(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_ROAD); },
    isSidewalk(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_SIDEWALK); },
    isWater(x, z) { return !ok(x, z) || !!(mask[cell(x, z)] & M_WATER); },
    isTunnel(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_TUNNEL); },
    isBridge(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_BRIDGE); },
    isShoulder(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_SHOULDER); },
    /** Inside the flat city footprint (incl. port + farm lots). */
    isCity(x, z) { return ok(x, z) && !!(mask[cell(x, z)] & M_CITY); },
    /** Block id painted on the street surface (asphalt / white / yellow paint / sidewalk), 0 if none. */
    roadBlockAt(x, z) { return ok(x, z) ? top[cell(x, z)] : 0; },
    lotAt(x, z) { if (!ok(x, z)) return null; const k = lotIdx[cell(x, z)]; return k >= 0 ? lots[k] : null; },
    /** Standing height on top of the building at (x,z) (roof), or null if no building there. */
    roofAt(x, z) { if (!ok(x, z)) return null; const v = roofH[cell(x, z)]; return v > CL ? v : null; },
    /** All lots of a given type ('building', 'tower', 'house', 'park', 'plaza', 'parking', 'shop', 'industrial', 'empty'). */
    lotsOfType(type) { return lots.filter((l) => l.type === type); },
    roadAt(x, z) { if (!ok(x, z)) return null; const k = roadIdx[cell(x, z)]; return k >= 0 ? roads[k] : null; },
    nearestNode(x, z) {
      if (!nodes.length) return null;
      const bx = clamp(Math.floor(z / BIN), 0, NB - 1), by = clamp(Math.floor(x / BIN), 0, NB - 1);
      let best = null, bd = Infinity;
      for (let ring = 0; ring < NB; ring++) {
        for (let dz = -ring; dz <= ring; dz++) {
          for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const zz = bx + dz, xx = by + dx;
            if (zz < 0 || xx < 0 || zz >= NB || xx >= NB) continue;
            for (const nd of bins[zz * NB + xx]) {
              const d = (nd.x - x) ** 2 + (nd.z - z) ** 2;
              if (d < bd) { bd = d; best = nd; }
            }
          }
        }
        if (best && Math.sqrt(bd) <= ring * BIN) break;
      }
      return best;
    },
    districtAt(x, z) {
      if (!ok(x, z)) return districtObjs[DIST.ocean];
      return districtObjs[distIdx[cell(x, z)]];
    },
    colorAt(x, z) { return ok(x, z) ? color[cell(x, z)] : 0x1d4f9c; },
    poisOfType(type) { return byType.get(type) || []; },
    /** Sidewalk centre-line offset from a road's centre line (for pedestrians). */
    sidewalkOffset(road) { return road.width / 2 + 1.5; },
    /** Nodes of a road as objects {a, b}. */
    roadEnds(road) { return { a: nodes[road.a], b: nodes[road.b] }; },
  };
  return plan;
}

export { WORLD, M_ROAD, M_SIDEWALK, M_WATER, M_CITY, M_TUNNEL, M_BRIDGE, M_SHOULDER, M_NOPROP };
