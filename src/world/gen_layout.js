// City + countryside layout: road graph (nodes/roads), lots (with types, heights, styles, fronts) and POI anchors.
// Pure data, deterministic from the seed. Terrain-independent (terrain adapts to the layout, not vice versa).
import { makeRng } from '../core/math.js';
import {
  GRID, gridHalf, SIDEWALK_W, ROAD_KINDS, RING, MINE, FARM, PORT, DGRID, DIST, DISTRICTS, CL, YAW_TO_FRONT, FACE_DX, FACE_DZ, h2,
} from './gen_const.js';

// ---------------------------------------------------------------------------------------------
// Road network
// ---------------------------------------------------------------------------------------------

/** Disabled city segments (merged blocks: park, port yard, industrial). key = 'v,i,j' or 'h,j,i'. */
const REMOVED = new Set([
  'v,3,2', 'v,3,3', 'h,3,2', 'h,3,3', // Greenblock Park superblock (x=212 / z=212 inside it)
  'v,7,6', 'v,7,7', 'h,7,6', 'h,7,7', // Port Anvil yard
  'v,5,6', 'v,5,7',                   // Ironworks: long warehouse blocks
]);

function buildLines() {
  const lines = [];
  const add = (x0, z0, x1, z1, kind) => {
    lines.push({ x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1), kind });
  };
  const n = GRID.length;
  // vertical city lines (x = GRID[i], running along z)
  for (let i = 0; i < n; i++) {
    const kind = i % 2 === 0 ? 'avenue' : 'street';
    let start = -1;
    for (let j = 0; j <= n - 1; j++) {
      const en = j < n - 1 && !REMOVED.has(`v,${i},${j}`);
      if (en && start < 0) start = j;
      if (!en && start >= 0) { add(GRID[i], GRID[start], GRID[i], GRID[j], kind); start = -1; }
    }
  }
  // horizontal city lines (z = GRID[j], running along x)
  for (let j = 0; j < n; j++) {
    const kind = j % 2 === 0 ? 'avenue' : 'street';
    let start = -1;
    for (let i = 0; i <= n - 1; i++) {
      const en = i < n - 1 && !REMOVED.has(`h,${j},${i}`);
      if (en && start < 0) start = i;
      if (!en && start >= 0) { add(GRID[start], GRID[j], GRID[i], GRID[j], kind); start = -1; }
    }
  }
  const c0 = GRID[0], c1 = GRID[n - 1];
  // connectors city <-> ring (highway, continue the avenues)
  for (const x of [176, 320]) { add(x, RING.z0, x, c0, 'highway'); add(x, c1, x, RING.z1, 'highway'); }
  for (const z of [176, 320]) { add(RING.x0, z, c0, z, 'highway'); add(c1, z, RING.x1, z, 'highway'); }
  // ring highway
  add(RING.x0, RING.z0, RING.x1, RING.z0, 'highway');
  add(RING.x1, RING.z0, RING.x1, RING.z1, 'highway');
  add(RING.x0, RING.z1, RING.x1, RING.z1, 'highway');
  add(RING.x0, RING.z0, RING.x0, RING.z1, 'highway');
  // country roads: to the mine (north, into the mountains) and to the farm (south)
  add(MINE.roadX, MINE.roadEndZ, MINE.roadX, RING.z0, 'country');
  add(FARM.roadX, RING.z1, FARM.roadX, 466, 'country');
  return lines;
}

/** Build {nodes, roads} from axis-aligned lines: nodes at endpoints + crossings, roads between consecutive nodes. */
export function buildRoadNetwork() {
  const lines = buildLines();
  const nodes = [];
  const nodeMap = new Map();
  const nodeAt = (x, z) => {
    const k = x + ',' + z;
    let nd = nodeMap.get(k);
    if (!nd) { nd = { id: nodes.length, x, z, edges: [] }; nodes.push(nd); nodeMap.set(k, nd); }
    return nd;
  };
  for (const l of lines) { nodeAt(l.x0, l.z0); nodeAt(l.x1, l.z1); }
  for (const a of lines) {
    if (a.x0 !== a.x1) continue; // a vertical
    for (const b of lines) {
      if (b.z0 !== b.z1) continue; // b horizontal
      if (a.x0 >= b.x0 && a.x0 <= b.x1 && b.z0 >= a.z0 && b.z0 <= a.z1) nodeAt(a.x0, b.z0);
    }
  }
  const roads = [];
  for (const l of lines) {
    const vertical = l.x0 === l.x1;
    const on = nodes.filter((nd) => (vertical
      ? nd.x === l.x0 && nd.z >= l.z0 && nd.z <= l.z1
      : nd.z === l.z0 && nd.x >= l.x0 && nd.x <= l.x1));
    on.sort((p, q) => (vertical ? p.z - q.z : p.x - q.x));
    const k = ROAD_KINDS[l.kind];
    for (let i = 0; i + 1 < on.length; i++) {
      const r = { id: roads.length, a: on[i].id, b: on[i + 1].id, width: k.width, lanes: k.lanes, speedLimit: k.speedLimit, kind: l.kind };
      roads.push(r);
      on[i].edges.push(r.id);
      on[i + 1].edges.push(r.id);
    }
  }
  return { nodes, roads };
}

// ---------------------------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------------------------

/** Interior span of city block index bi (between grid line bi and bi+1), inside the sidewalks. */
export function blockSpan(bi) {
  return [GRID[bi] + gridHalf(bi) + SIDEWALK_W, GRID[bi + 1] - gridHalf(bi + 1) - SIDEWALK_W];
}

const isAve = (lineIdx) => lineIdx % 2 === 0;

/**
 * Build all lots + POI anchors. Returns { lots, poiSpecs }.
 * Each lot: { id, x0, z0, x1, z1, type, height, district, style, front, ...extras }
 */
export function buildLots(seed) {
  const rng = makeRng((seed ^ 0x5bd1e995) >>> 0);
  const lots = [];
  const poiSpecs = [];
  const addLot = (o) => { o.id = lots.length; o.seed = (Math.floor(h2(o.x0, o.z0, seed) * 0x7fffffff)) | 0; lots.push(o); return o; };

  // which sides of a rect touch which road line (for fronts)
  const sideRoad = (bi0, bi1, bj0, bj1, rect) => {
    // returns per face [N,E,S,W] the road weight (2 avenue, 1 street, 0 none)
    const [x0, z0, x1, z1] = rect;
    const bx = blockSpan(bi0), bx1 = blockSpan(bi1), bz = blockSpan(bj0), bz1 = blockSpan(bj1);
    return [
      z0 === bz[0] ? (isAve(bj0) ? 2 : 1) : 0,
      x1 === bx1[1] ? (isAve(bi1 + 1) ? 2 : 1) : 0,
      z1 === bz1[1] ? (isAve(bj1 + 1) ? 2 : 1) : 0,
      x0 === bx[0] ? (isAve(bi0) ? 2 : 1) : 0,
    ];
  };
  const pickFront = (w, salt, prefer = -1) => {
    if (prefer >= 0 && w[prefer] > 0) return prefer;
    let best = -1, bw = -1;
    for (let f = 0; f < 4; f++) {
      const v = w[f] + h2(salt, f, seed) * 0.5;
      if (w[f] > 0 && v > bw) { bw = v; best = f; }
    }
    return best < 0 ? 2 : best;
  };

  const towerHeight = (cx, cz) => {
    const d = Math.hypot(cx - 248, cz - 248);
    const t = 1 - Math.min(1, Math.max(0, (d - 14) / 100));
    return Math.round(Math.min(62, 26 + 30 * t * t + rng() * 9 + (d < 40 ? 4 : 0)));
  };

  // Fixed special blocks (bi,bj) -> spec
  const SPECIAL = {
    '1,2': 'safehouse', '5,1': 'hospital', '3,1': 'police', '1,1': 'gunshop', '3,6': 'hardware', '2,7': 'garage',
    '3,7': 'plaza_market', '2,6': 'parking', '7,0': 'parking', '7,4': 'parking', '0,1': 'parking', '5,2': 'parking',
    '3,5': 'plaza_downtown', '5,5': 'plaza', '0,5': 'pocketpark', '0,0': 'oldtown_mission', '0,6': 'res_mission', '4,0': 'site',
  };

  for (let sz = 0; sz < 4; sz++) {
    for (let sx = 0; sx < 4; sx++) {
      const district = DGRID[sz][sx];
      const did = DIST[district];
      const bi0 = sx * 2, bj0 = sz * 2;
      if (district === 'park') {
        const x = blockSpan(bi0), x1 = blockSpan(bi0 + 1), z = blockSpan(bj0), z1 = blockSpan(bj0 + 1);
        addLot({ x0: x[0], z0: z[0], x1: x1[1], z1: z1[1], type: 'park', height: 0, district: did, style: 'central', front: 2 });
        continue;
      }
      if (district === 'port') {
        const x = blockSpan(bi0), x1 = blockSpan(bi0 + 1), z = blockSpan(bj0), z1 = blockSpan(bj0 + 1);
        addLot({ x0: x[0], z0: z[0], x1: x1[1], z1: z1[1], type: 'industrial', height: 12, district: did, style: 'portyard', front: 3 });
        continue;
      }
      if (district === 'industrial') {
        for (let bj = bj0; bj < bj0 + 2; bj++) {
          const x = blockSpan(bi0), x1 = blockSpan(bi0 + 1), z = blockSpan(bj);
          const lot = addLot({ x0: x[0], z0: z[0], x1: x1[1], z1: z[1], type: 'industrial', height: 11 + Math.floor(rng() * 5), district: did, style: bj === bj0 ? 'factory' : 'warehouse', front: bj === bj0 ? 0 : 2 });
          if (bj === bj0) poiSpecs.push({ type: 'mission', name: 'Ironworks Foundry', lot, face: 0, at: 0.3 });
        }
        continue;
      }
      for (let bj = bj0; bj < bj0 + 2; bj++) {
        for (let bi = bi0; bi < bi0 + 2; bi++) {
          const [x0, x1] = blockSpan(bi), [z0, z1] = blockSpan(bj);
          const special = SPECIAL[bi + ',' + bj];
          const w = sideRoad(bi, bi, bj, bj, [x0, z0, x1, z1]);
          const salt = bi * 31 + bj * 7;
          const full = (o) => addLot({ x0, z0, x1, z1, district: did, ...o });
          if (special === 'safehouse') {
            // west half: two houses; east half: the safehouse villa facing the park avenue
            addLot({ x0, z0, x1: x0 + 10, z1: z0 + 10, type: 'house', height: 8, district: did, style: 'house', front: 0 });
            addLot({ x0, z0: z0 + 10, x1: x0 + 10, z1, type: 'house', height: 8, district: did, style: 'house', front: 2 });
            const lot = addLot({ x0: x0 + 10, z0, x1, z1, type: 'house', height: 11, district: did, style: 'safehouse', front: 1, poi: 'safehouse' });
            poiSpecs.push({ type: 'safehouse', name: 'Safehouse', lot, face: 1, at: 0.5, spawn: true });
            continue;
          }
          if (special === 'hospital') {
            const lot = full({ type: 'building', height: 22, style: 'hospital', front: 2, poi: 'hospital' });
            poiSpecs.push({ type: 'hospital', name: 'St. Brick Hospital', lot, face: 2, at: 0.5 });
            continue;
          }
          if (special === 'police') {
            const lot = full({ type: 'building', height: 15, style: 'police', front: 2, poi: 'police' });
            poiSpecs.push({ type: 'police', name: 'Cobbleton Police Dept.', lot, face: 2, at: 0.5 });
            continue;
          }
          if (special === 'gunshop') {
            // quad: 3 walk-ups + the gun shop on the SE corner facing the avenue
            addLot({ x0, z0, x1: x0 + 10, z1: z0 + 10, type: 'building', height: 10 + Math.floor(rng() * 5), district: did, style: 'walkup', front: 3 });
            addLot({ x0: x0 + 10, z0, x1, z1: z0 + 10, type: 'building', height: 10 + Math.floor(rng() * 5), district: did, style: 'walkup', front: 0 });
            addLot({ x0, z0: z0 + 10, x1: x0 + 10, z1, type: 'shop', height: 9, district: did, style: 'walkup', front: 2 });
            const lot = addLot({ x0: x0 + 10, z0: z0 + 10, x1, z1, type: 'shop', height: 7, district: did, style: 'gunshop', front: 2, poi: 'gunshop' });
            poiSpecs.push({ type: 'gunshop', name: 'Boom Bros. Ammu-Blocks', lot, face: 2, at: 0.5 });
            continue;
          }
          if (special === 'hardware') {
            const lot = full({ type: 'shop', height: 9, style: 'hardware', front: 0, poi: 'hardware' });
            poiSpecs.push({ type: 'hardware', name: 'Block Depot Hardware', lot, face: 0, at: 0.5 });
            continue;
          }
          if (special === 'garage') {
            const lot = full({ type: 'shop', height: 9, style: 'garage', front: 3, poi: 'garage' });
            poiSpecs.push({ type: 'garage', name: 'Pixel Pay\'n\'Spray', lot, face: 3, at: 0.5 });
            continue;
          }
          if (special === 'parking') {
            full({ type: 'parking', height: 0, style: 'lot', front: pickFront(w, salt) });
            continue;
          }
          if (special === 'plaza' || special === 'plaza_downtown' || special === 'plaza_market') {
            const lot = full({ type: 'plaza', height: 0, style: special === 'plaza_market' ? 'market' : 'plaza', front: pickFront(w, salt) });
            if (special === 'plaza_downtown') poiSpecs.push({ type: 'mission', name: 'Blockton Plaza', lot, face: lot.front, at: 0.5 });
            continue;
          }
          if (special === 'site') {
            full({ type: 'empty', height: 0, style: 'site', front: 2 });
            continue;
          }
          if (special === 'pocketpark') {
            full({ type: 'park', height: 0, style: 'pocket', front: pickFront(w, salt) });
            continue;
          }

          if (district === 'downtown') {
            const h = towerHeight((x0 + x1) / 2, (z0 + z1) / 2);
            full({ type: 'tower', height: h, style: 'tower', front: pickFront(w, salt) });
          } else if (district === 'residential') {
            const res = [];
            if (rng() < 0.25 && special !== 'res_mission') {
              // two big houses (10 wide x 20 deep) or (20 x 10)
              if (rng() < 0.5) {
                res.push([x0, z0, x0 + 10, z1], [x0 + 10, z0, x1, z1]);
              } else {
                res.push([x0, z0, x1, z0 + 10], [x0, z0 + 10, x1, z1]);
              }
            } else {
              res.push([x0, z0, x0 + 10, z0 + 10], [x0 + 10, z0, x1, z0 + 10], [x0, z0 + 10, x0 + 10, z1], [x0 + 10, z0 + 10, x1, z1]);
            }
            res.forEach((r, k) => {
              const ww = sideRoad(bi, bi, bj, bj, r);
              const lot = addLot({ x0: r[0], z0: r[1], x1: r[2], z1: r[3], type: 'house', height: 6 + Math.floor(rng() * 5), district: did, style: 'house', front: pickFront(ww, salt + k * 3) });
              if (special === 'res_mission' && k === 3) poiSpecs.push({ type: 'mission', name: 'Birchwood Cul-de-sac', lot, face: lot.front, at: 0.5 });
            });
          } else if (district === 'oldtown') {
            const parts = rng() < 0.5
              ? [[x0, z0, x0 + 10, z1], [x0 + 10, z0, x1, z1]]
              : [[x0, z0, x0 + 10, z0 + 10], [x0 + 10, z0, x1, z0 + 10], [x0, z0 + 10, x1, z1]];
            parts.forEach((r, k) => {
              const ww = sideRoad(bi, bi, bj, bj, r);
              const lot = addLot({ x0: r[0], z0: r[1], x1: r[2], z1: r[3], type: rng() < 0.6 ? 'shop' : 'building', height: 9 + Math.floor(rng() * 8), district: did, style: 'walkup', front: pickFront(ww, salt + k * 5), hollow: rng() < 0.35 });
              if (special === 'oldtown_mission' && k === 0) poiSpecs.push({ type: 'mission', name: 'Cobbleton Pawn & Loan', lot, face: lot.front, at: 0.5 });
            });
          } else if (district === 'midtown' || district === 'bayfront' || district === 'market') {
            const style = district === 'bayfront' ? 'hotel' : 'midrise';
            const hr = district === 'bayfront' ? [14, 34] : district === 'market' ? [9, 16] : [12, 30];
            if (rng() < 0.5) {
              full({ type: district === 'market' ? 'shop' : 'building', height: hr[0] + Math.floor(rng() * (hr[1] - hr[0])), style, front: pickFront(w, salt), hollow: rng() < 0.3 });
            } else {
              const splitX = rng() < 0.5;
              const parts = splitX ? [[x0, z0, x0 + 10, z1], [x0 + 10, z0, x1, z1]] : [[x0, z0, x1, z0 + 10], [x0, z0 + 10, x1, z1]];
              parts.forEach((r, k) => {
                const ww = sideRoad(bi, bi, bj, bj, r);
                addLot({ x0: r[0], z0: r[1], x1: r[2], z1: r[3], type: rng() < 0.5 ? 'shop' : 'building', height: hr[0] + Math.floor(rng() * (hr[1] - hr[0])), district: did, style, front: pickFront(ww, salt + k * 11), hollow: rng() < 0.3 });
              });
            }
          }
        }
      }
    }
  }

  // ---- port land outside the grid (between the city edge and the quay) ----
  const did = DIST.port;
  addLot({ x0: 403, z0: 334, x1: 424, z1: 368, type: 'industrial', height: 10, district: did, style: 'containers', front: 3 });
  addLot({ x0: 403, z0: 372, x1: 424, z1: 428, type: 'industrial', height: 14, district: did, style: 'warehouse', front: 3 });
  const heli = addLot({ x0: 440, z0: 334, x1: 462, z1: 356, type: 'plaza', height: 0, district: did, style: 'helipad', front: 3 });
  const quay = addLot({ x0: 440, z0: 360, x1: PORT.quayX, z1: 428, type: 'industrial', height: 0, district: did, style: 'quay', front: 3 });
  poiSpecs.push({ type: 'helipad', name: 'Port Anvil Heliport', lot: heli, center: true });
  poiSpecs.push({ type: 'mission', name: 'Pier 9 Docks', lot: quay, custom: { x: 452.5, z: 392.5, yaw: Math.PI / 2 } });

  // ---- farm (south of the ring) ----
  const fd = DIST.farm;
  addLot({ x0: 152, z0: 450, x1: 166, z1: 462, type: 'house', height: 10, district: fd, style: 'farmhouse', front: 3 });
  const barn = addLot({ x0: 124, z0: 449, x1: 144, z1: 465, type: 'building', height: 13, district: fd, style: 'barn', front: 1 });
  addLot({ x0: 96, z0: 450, x1: 122, z1: 482, type: 'empty', height: 0, district: fd, style: 'field', front: 1 });
  addLot({ x0: 168, z0: 466, x1: 210, z1: 484, type: 'empty', height: 0, district: fd, style: 'field', front: 0 });
  addLot({ x0: 152, z0: 468, x1: 166, z1: 482, type: 'empty', height: 0, district: fd, style: 'farmyard', front: 3 });
  poiSpecs.push({ type: 'mission', name: 'Hayfield Barn', lot: barn, custom: { x: 142.5, z: 457.0, yaw: -Math.PI / 2 } });

  // ---- mine camp + mine + beach (positions fixed by the terrain structures) ----
  poiSpecs.push({ type: 'mine', name: 'Granite Peak Mine', custom: { x: MINE.roadX + 0.5, z: MINE.roadEndZ + 2.5, yaw: Math.PI } });
  poiSpecs.push({ type: 'mission', name: 'Prospector\'s Camp', custom: { x: MINE.roadX + 7.5, z: 60.5, yaw: Math.PI / 2 } });
  poiSpecs.push({ type: 'beach', name: 'Sunstone Beach', custom: { x: 443.5, z: 206.5, yaw: Math.PI / 2 } });
  poiSpecs.push({ type: 'mission', name: 'Sunstone Boardwalk', custom: { x: 443.5, z: 262.5, yaw: Math.PI / 2 } });

  // contract: lot.district is the district id string (same ids as plan.districtAt().id)
  for (const l of lots) { l.districtIndex = l.district; l.district = DISTRICTS[l.district].id; }
  return { lots, poiSpecs };
}

/** Resolve POI specs into contract POIs {id,type,name,x,y,z,yaw}. Door position = middle of the front facade. */
export function resolvePois(poiSpecs) {
  const pois = [];
  for (const s of poiSpecs) {
    let x, z, yaw;
    if (s.custom) { x = s.custom.x; z = s.custom.z; yaw = s.custom.yaw; }
    else if (s.center) { x = (s.lot.x0 + s.lot.x1) / 2; z = (s.lot.z0 + s.lot.z1) / 2; yaw = 0; }
    else {
      const L = s.lot, f = s.face;
      const along = f === 0 || f === 2;
      const door = along ? Math.floor(L.x0 + (L.x1 - L.x0) * s.at) : Math.floor(L.z0 + (L.z1 - L.z0) * s.at);
      L.door = door;
      // middle column of the sidewalk (1 block outside the lot edge + 0.5)
      if (f === 0) { x = door + 0.5; z = L.z0 - 1.5; }
      if (f === 2) { x = door + 0.5; z = L.z1 + 1.5; }
      if (f === 1) { x = L.x1 + 1.5; z = door + 0.5; }
      if (f === 3) { x = L.x0 - 1.5; z = door + 0.5; }
      yaw = YAW_TO_FRONT[f];
    }
    pois.push({ id: pois.length, type: s.type, name: s.name, x, y: CL, z, yaw, lot: s.lot ? s.lot.id : -1, spawn: !!s.spawn, face: s.face });
  }
  return pois;
}

export { FACE_DX, FACE_DZ };
