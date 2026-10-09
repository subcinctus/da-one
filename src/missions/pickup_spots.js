// Where the world pickups go, derived deterministically from the city plan (pure: node-testable).
// Returns spawn specs: { type, x, y, z, amount, respawn, tag }. y is a standing-height hint that Pickups refines
// against the real voxel world once the chunk is loaded.
import { WORLD } from '../core/config.js';
import { rng32 } from './util.js';

const CL = WORLD.CITY_LEVEL;

function pois(plan, type) {
  try { return typeof plan.poisOfType === 'function' ? plan.poisOfType(type) || [] : (plan.pois || []).filter((p) => p.type === type); } catch (e) { return []; }
}

/** Point on the sidewalk beside a POI (right of the door when facing it), `side` metres along the facade. */
export function besidePoi(poi, side = 3.2, back = 0) {
  const yaw = Number.isFinite(poi.yaw) ? poi.yaw : 0;
  const rx = -Math.cos(yaw), rz = Math.sin(yaw);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return { x: poi.x + rx * side - fx * back, y: Number.isFinite(poi.y) ? poi.y : CL, z: poi.z + rz * side - fz * back };
}

/** City cells that are neither lot, road nor sidewalk (gaps between blocks), sampled every 2 m. */
export function findAlleys(plan) {
  const out = [];
  const b = plan.cityBounds || { x0: WORLD.CITY_MIN, z0: WORLD.CITY_MIN, x1: WORLD.CITY_MAX, z1: WORLD.CITY_MAX };
  const isCity = typeof plan.isCity === 'function' ? (x, z) => plan.isCity(x, z) : () => true;
  for (let z = b.z0 + 1; z < b.z1 - 1; z += 2) {
    for (let x = b.x0 + 1; x < b.x1 - 1; x += 2) {
      const cx = x + 0.5, cz = z + 0.5;
      if (!isCity(cx, cz)) continue;
      if (plan.lotAt(cx, cz) || plan.isRoad(cx, cz) || plan.isSidewalk(cx, cz) || plan.isWater(cx, cz)) continue;
      out.push({ x: cx, y: CL, z: cz });
    }
  }
  return out;
}

/** Interior points of lots of the given types (park/plaza/parking), away from water. */
export function lotSpots(plan, types) {
  const out = [];
  for (const l of plan.lots || []) {
    if (!types.includes(l.type)) continue;
    const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2;
    const cand = [[cx, cz], [l.x0 + 2.5, l.z0 + 2.5], [l.x1 - 2.5, l.z1 - 2.5], [l.x0 + 2.5, l.z1 - 2.5], [l.x1 - 2.5, l.z0 + 2.5]];
    for (const [x, z] of cand) {
      if (plan.isWater(x, z)) continue;
      out.push({ x: Math.floor(x) + 0.5, y: plan.surfaceY(x, z), z: Math.floor(z) + 0.5, lot: l });
      break;
    }
  }
  return out;
}

/** Highest terrain point in the northern mountains (sampled), standing height. */
export function mountainPeak(plan) {
  if (typeof plan.heightAt !== 'function') return null;
  let best = null;
  for (let z = 8; z < 140; z += 3) {
    for (let x = 8; x < WORLD.SIZE_X - 8; x += 3) {
      if (plan.isWater(x, z) || (typeof plan.isRoad === 'function' && plan.isRoad(x, z))) continue;
      const h = plan.heightAt(x, z);
      if (!best || h > best.y) best = { x: x + 0.5, y: h, z: z + 0.5 };
    }
  }
  return best && best.y > CL + 12 ? best : null;
}

function farEnough(list, p, minD) {
  for (const q of list) if (Math.hypot(q.x - p.x, q.z - p.z) < minD) return false;
  return true;
}

/**
 * All world pickup specs for a plan. Every entry respawns after `respawn` seconds (default 120).
 */
export function worldPickupSpecs(plan, seed = 1) {
  const out = [];
  if (!plan) return out;
  const R = rng32((seed ^ 0x51c4a3) >>> 0);
  const add = (type, p, amount, tag, respawn = 120) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    out.push({ type, x: p.x, y: Number.isFinite(p.y) ? p.y : CL, z: p.z, amount, respawn, tag });
  };

  // health beside each hospital, armor at each police station
  for (const h of pois(plan, 'hospital')) { add('health', besidePoi(h, 3.4), 100, 'hospital'); add('health', besidePoi(h, -3.4), 100, 'hospital'); }
  for (const p of pois(plan, 'police')) add('armor', besidePoi(p, 3.4), 100, 'police');

  // rooftops (reachable through stairwells): shotgun, armor and cash bundles
  const roofs = (plan.rooftops || []).slice();
  roofs.sort((a, b) => (a.x + a.z * 0.37) - (b.x + b.z * 0.37));
  const roofPlan = [['weapon:shotgun', 30], ['cash', 400], ['armor', 50], ['cash', 300], ['weapon:smg', 90]];
  for (let i = 0; i < roofs.length && i < roofPlan.length; i++) {
    const r = roofs[i];
    add(roofPlan[i][0], { x: r.x, y: r.y, z: r.z }, roofPlan[i][1], 'rooftop');
  }

  // alleys: bat, SMG (if no roof took it), cash
  const alleys = findAlleys(plan);
  const picked = [];
  for (let tries = 0; tries < 60 && picked.length < 3 && alleys.length; tries++) {
    const a = alleys[Math.floor(R() * alleys.length)];
    if (farEnough(picked, a, 45)) picked.push(a);
  }
  const alleyPlan = [['weapon:bat', 0], [out.some((o) => o.type === 'weapon:smg') ? 'cash' : 'weapon:smg', out.some((o) => o.type === 'weapon:smg') ? 250 : 90], ['cash', 200]];
  // not enough alleys? fall back to parking lots / plazas
  const lotsFallback = lotSpots(plan, ['parking', 'plaza', 'park']);
  while (picked.length < 3 && lotsFallback.length) {
    const l = lotsFallback.splice(Math.floor(R() * lotsFallback.length), 1)[0];
    if (farEnough(picked, l, 30)) picked.push(l);
  }
  for (let i = 0; i < picked.length; i++) add(alleyPlan[i][0], picked[i], alleyPlan[i][1], 'alley');

  // parks: health + cash
  const parks = lotSpots(plan, ['park']);
  if (parks[0]) { add('health', parks[0], 60, 'park'); add('cash', { x: parks[0].x + 4, y: parks[0].y, z: parks[0].z + 3 }, 150, 'park'); }

  // mountain peak: sniper rifle + a fat bundle for the climb
  const peak = mountainPeak(plan);
  if (peak) {
    add('weapon:sniper', peak, 10, 'peak');
    add('cash', { x: peak.x + 2, y: peak.y, z: peak.z + 1 }, 750, 'peak');
  }

  // mine: cash in the cavern, TNT crates + health at the entrance
  const mine = plan.mine;
  if (mine && mine.cavern) add('cash', { x: mine.cavern.x + 2, y: mine.cavern.y, z: mine.cavern.z - 1 }, 500, 'mine');
  for (const m of pois(plan, 'mine')) {
    add('block:TNT', besidePoi(m, 3, 1), 8, 'mine');
    add('block:TNT', besidePoi(m, -3, 1), 8, 'mine');
    add('health', besidePoi(m, 0, 3.5), 60, 'mine');
  }

  // beach: cash near the waterline + health at the boardwalk
  for (const b of pois(plan, 'beach')) {
    const yaw = Number.isFinite(b.yaw) ? b.yaw : 0;
    add('cash', { x: b.x + Math.sin(yaw) * 14, y: b.y, z: b.z + Math.cos(yaw) * 14 }, 200, 'beach');
    add('health', besidePoi(b, 4), 60, 'beach');
  }

  // port: grenades among the containers, cash on the quay
  for (const l of plan.lots || []) {
    if (l.district !== 'port' || l.type !== 'industrial') continue;
    if (l.style === 'containers' && !out.some((o) => o.type === 'weapon:grenade')) {
      const e = l.entrance || { x: (l.x0 + l.x1) / 2, z: l.z0 - 1 };
      add('weapon:grenade', { x: e.x, y: CL, z: e.z }, 3, 'port');
    }
    if (l.style === 'quay' && !out.some((o) => o.tag === 'quay')) {
      add('cash', { x: (l.x0 + l.x1) / 2 + 0.5, y: CL, z: l.z1 - 4.5 }, 300, 'quay');
    }
  }

  // farm: cash in the barn yard
  const barn = (plan.lots || []).find((l) => l.style === 'barn');
  if (barn && barn.entrance) add('cash', { x: barn.entrance.x, y: barn.entrance.y || CL, z: barn.entrance.z }, 200, 'farm');

  // gun shop: a little pistol ammo out front (newbie friendly)
  for (const gs of pois(plan, 'gunshop')) add('ammo:pistol', besidePoi(gs, 3.2), 24, 'gunshop');

  // keep pickups off shop / mission markers (walking into one should not also open a shop)
  const marks = (plan.pois || []).filter((p) => p.type !== 'helipad');
  for (const o of out) {
    for (let k = 0; k < 4; k++) {
      const hit = marks.find((p) => Math.hypot(p.x - o.x, p.z - o.z) < 2.8);
      if (!hit) break;
      const yaw = Number.isFinite(hit.yaw) ? hit.yaw : 0;
      o.x += -Math.cos(yaw) * 2.2;
      o.z += Math.sin(yaw) * 2.2;
    }
  }
  return out;
}
