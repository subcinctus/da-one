// Mission definitions, derived from the city plan (POIs, lots, rooftops, roads, parking spots, the mine).
// buildMissionDefs(game) -> [def]. Each def: {id, title, letter, blurb, intro, brief, reward, difficulty, giver (poi),
// timeLimit?, setup(run)?, steps: [spec | (run) => spec|null], rewardFor(run)?, passNote(run)?, vehicleName?,
// protectVehicle?}. A mission whose prerequisites are missing from the plan is skipped (not listed).
import { B } from '../world/blocks.js';
import { WORLD } from '../core/config.js';
import { LOOKS } from '../entities/humanoid.js';
import { besidePoi, lotSpots } from './pickup_spots.js';
import { poisOfType, planOf, rng32, dist2D, fmtClock, fmtMoney, districtName, safe } from './util.js';

const CL = WORLD.CITY_LEVEL;

/** Display order in the mission log. */
export const MISSION_ORDER = ['joyride', 'race', 'packages', 'demolition', 'diamonds', 'hit', 'builder', 'taxi'];

function districtCenter(plan, id) {
  const d = (plan.districts || []).find((q) => q.id === id);
  return d ? { x: d.x, z: d.z } : null;
}

function drivable(plan, x, z) {
  return (typeof plan.isRoad === 'function' && plan.isRoad(x, z)) || (typeof plan.isSidewalk === 'function' && plan.isSidewalk(x, z));
}

// ================================================================================================ race route

/** Build a checkpoint route through the road graph starting near (x, z). Returns {start, points, length} or null. */
export function buildRaceRoute(plan, x, z, seed = 1) {
  if (!plan || !plan.nodes || !plan.roads || typeof plan.nearestNode !== 'function') return null;
  const R = rng32(seed);
  const n0 = plan.nearestNode(x, z);
  if (!n0) return null;
  const nodes = plan.nodes, roads = plan.roads;
  const path = [n0];
  const visited = new Set([n0.id]);
  let prevDir = null, prevRoad = null, total = 0;
  for (let step = 0; step < 40 && total < 1250; step++) {
    const cur = path[path.length - 1];
    const opts = [];
    for (const ri of cur.edges || []) {
      const r = roads[ri];
      if (!r || r === prevRoad || r.kind === 'country') continue;
      const oid = r.a === cur.id ? r.b : r.a;
      const o = nodes[oid];
      if (!o || visited.has(oid)) continue;
      const L = Math.hypot(o.x - cur.x, o.z - cur.z);
      if (L < 8) continue;
      const dir = { x: (o.x - cur.x) / L, z: (o.z - cur.z) / L };
      const straight = prevDir ? dir.x * prevDir.x + dir.z * prevDir.z : 0;
      // like straights and long roads, avoid hairpins, a dash of randomness for variety
      const score = straight * 1.2 + Math.min(L, 120) / 120 + R() * 0.9 - (straight < -0.5 ? 5 : 0);
      opts.push({ r, o, L, dir, score });
    }
    if (!opts.length) break;
    opts.sort((a, b) => b.score - a.score);
    const c = opts[0];
    path.push(c.o);
    visited.add(c.o.id);
    total += c.L;
    prevDir = c.dir;
    prevRoad = c.r;
  }
  if (total < 450 || path.length < 3) return null;
  // polyline samples: corners + every <= 130 m along straights
  const raw = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.ceil(L / 40));
    const roadW = widthBetween(plan, a, b);
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      raw.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: Math.atan2(b.x - a.x, b.z - a.z), w: roadW, corner: j === k });
    }
  }
  // cumulative distance of every sample along the route
  let acc = 0;
  let px = path[0].x, pz = path[0].z;
  for (const r of raw) { acc += Math.hypot(r.x - px, r.z - pz); r.dist = acc; px = r.x; pz = r.z; }
  // pick ~10 checkpoints evenly by distance (snapping to corners when one is close), never within 45 m of the start
  const target = Math.max(4, Math.min(10, Math.round(acc / 95)));
  const pts = [];
  for (let i = 1; i <= target; i++) {
    const want = (acc * i) / target;
    let best = null, bd = Infinity;
    for (const r of raw) {
      if (r.dist < 45 || pts.includes(r)) continue;
      const d = Math.abs(r.dist - want) - (r.corner ? 18 : 0);
      if (d < bd) { bd = d; best = r; }
    }
    if (best && (!pts.length || best.dist > pts[pts.length - 1].dist + 30)) pts.push(best);
  }
  if (pts.length && pts[pts.length - 1] !== raw[raw.length - 1]) {
    const last = raw[raw.length - 1];
    if (last.dist - pts[pts.length - 1].dist < 30) pts[pts.length - 1] = last; else pts.push(last);
  }
  if (pts.length < 4) return null;
  const s = path[0], s1 = path[1];
  const start = { x: s.x + 0.5, y: CL, z: s.z + 0.5, yaw: Math.atan2(s1.x - s.x, s1.z - s.z) };
  const points = pts.map((p) => ({ x: p.x + 0.5, y: typeof plan.surfaceY === 'function' ? plan.surfaceY(p.x, p.z) : CL, z: p.z + 0.5, yaw: p.yaw, radius: Math.max(5, p.w / 2 + 1.5) }));
  let length = Math.hypot(points[0].x - start.x, points[0].z - start.z);
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return { start, points, length };
}

function widthBetween(plan, a, b) {
  for (const ri of a.edges || []) {
    const r = plan.roads[ri];
    if (r && ((r.a === a.id && r.b === b.id) || (r.b === a.id && r.a === b.id))) return r.width || 10;
  }
  return 10;
}

// ================================================================================================ helpers

function lotCenter(l) { return { x: (l.x0 + l.x1) / 2, z: (l.z0 + l.z1) / 2 }; }

function poiLotIds(plan) {
  const s = new Set();
  for (const p of plan.pois || []) if (Number.isInteger(p.lot) && p.lot >= 0) s.add(p.lot);
  return s;
}

function rooftopLotIds(plan) {
  const s = new Set();
  for (const r of plan.rooftops || []) if (r && r.lot !== undefined) s.add(typeof r.lot === 'object' ? r.lot.id : r.lot);
  return s;
}

/** Demolition target near (x, z): a modest, non-POI building lot. */
export function pickDemolitionLot(plan, x, z, reserved = new Set()) {
  const bad = new Set([...poiLotIds(plan), ...rooftopLotIds(plan), ...reserved]);
  const lots = (plan.lots || []).filter((l) => !bad.has(l.id) && !l.poi);
  const score = (l) => dist2D(x, z, (l.x0 + l.x1) / 2, (l.z0 + l.z1) / 2);
  const area = (l) => (l.x1 - l.x0) * (l.z1 - l.z0);
  const ok = (l) => (l.type === 'building' || l.type === 'shop') && area(l) <= 240 && (l.height || 0) <= 16 && area(l) * (l.height || 0) >= 700 && area(l) * (l.height || 0) <= 2600;
  let best = lots.filter(ok).sort((a, b) => score(a) - score(b))[0];
  if (!best) best = lots.filter((l) => l.type === 'house' || ((l.type === 'building' || l.type === 'shop') && area(l) <= 400)).sort((a, b) => score(a) - score(b))[0];
  return best || null;
}

/** 10x10 build plot near (x, z): inside an empty lot if possible, else a flat open patch of land. */
export function pickBuildPlot(plan, x, z, size = 10) {
  const empties = (plan.lots || []).filter((l) => l.type === 'empty' && l.x1 - l.x0 >= 6 && l.z1 - l.z0 >= 6)
    .map((l) => ({ l, d: dist2D(x, z, (l.x0 + l.x1) / 2, (l.z0 + l.z1) / 2) })).filter((e) => e.d < 320).sort((a, b) => a.d - b.d);
  if (empties.length) {
    const l = empties[0].l;
    const w = Math.min(size, l.x1 - l.x0 - 2), d = Math.min(size, l.z1 - l.z0 - 2);
    const cx = Math.floor((l.x0 + l.x1) / 2), cz = Math.floor((l.z0 + l.z1) / 2);
    const x0 = cx - Math.floor(w / 2), z0 = cz - Math.floor(d / 2);
    return { x0, z0, x1: x0 + w, z1: z0 + d, y0: typeof plan.surfaceY === 'function' ? plan.surfaceY(cx + 0.5, cz + 0.5) : CL, lot: l };
  }
  // open flat terrain: spiral search for a size x size patch with height spread <= 1, no roads / water / lots
  if (typeof plan.heightAt !== 'function') return null;
  for (let r = 12; r < 160; r += 6) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x0 = Math.floor(x + Math.cos(ang) * r), z0 = Math.floor(z + Math.sin(ang) * r);
      let lo = Infinity, hi = -Infinity, bad = false;
      for (let zz = z0; zz < z0 + size && !bad; zz += 1) {
        for (let xx = x0; xx < x0 + size; xx += 1) {
          if (plan.isWater(xx, zz) || plan.isRoad(xx, zz) || (plan.isSidewalk && plan.isSidewalk(xx, zz)) || plan.lotAt(xx, zz)) { bad = true; break; }
          const hh = plan.heightAt(xx, zz);
          lo = Math.min(lo, hh); hi = Math.max(hi, hh);
          if (hi - lo > 1) { bad = true; break; }
        }
      }
      if (!bad) return { x0, z0, x1: x0 + size, z1: z0 + size, y0: hi, lot: null };
    }
  }
  return null;
}

/**
 * Choose the clearest size x size patch for the Builder plot by scanning the real voxels (run time): candidate windows
 * inside empty lots near (x, z) and on open ground around it. Penalises solid blocks in the 3 layers above the floor,
 * missing floor, roads, water and distance. Returns {x0, z0, x1, z1, y0} or null.
 */
export function findClearPlot(game, plan, x, z, size = 10) {
  const w = game && game.world;
  if (!w || typeof w.getBlock !== 'function') return pickBuildPlot(plan, x, z, size);
  const regions = [];
  for (const l of plan.lots || []) {
    if (l.type !== 'empty') continue;
    if (dist2D(x, z, (l.x0 + l.x1) / 2, (l.z0 + l.z1) / 2) > 260) continue;
    regions.push({ x0: l.x0, z0: l.z0, x1: l.x1, z1: l.z1 });
  }
  regions.push({ x0: Math.floor(x) - 40, z0: Math.floor(z) - 40, x1: Math.floor(x) + 40, z1: Math.floor(z) + 40 });
  let best = null, bestScore = Infinity;
  for (const r of regions) {
    for (let z0 = r.z0; z0 + size <= r.z1; z0 += 2) {
      for (let x0 = r.x0; x0 + size <= r.x1; x0 += 2) {
        const cx = x0 + size / 2, cz = z0 + size / 2;
        const y0 = typeof plan.surfaceY === 'function' ? plan.surfaceY(cx, cz) : CL;
        let score = dist2D(x, z, cx, cz) * 0.05;
        if (score >= bestScore) continue;
        for (let zz = z0; zz < z0 + size && score < bestScore; zz++) {
          for (let xx = x0; xx < x0 + size; xx++) {
            if (plan.isWater(xx + 0.5, zz + 0.5) || plan.isRoad(xx + 0.5, zz + 0.5)) { score += 6; continue; }
            if (typeof plan.isSidewalk === 'function' && plan.isSidewalk(xx + 0.5, zz + 0.5)) score += 2;
            if (!isSolidAt(w, xx, y0 - 1, zz)) score += 3;
            for (let y = y0; y < y0 + 3; y++) {
              const id = w.getBlock(xx, y, zz);
              if (id) score += isSolidAt(w, xx, y, zz) ? 4 : 0.15;
            }
          }
        }
        if (score < bestScore) { bestScore = score; best = { x0, z0, x1: x0 + size, z1: z0 + size, y0 }; }
      }
    }
  }
  return best || pickBuildPlot(plan, x, z, size);
}

function isSolidAt(w, x, y, z) {
  if (typeof w.isSolid === 'function') return w.isSolid(x, y, z);
  return !!w.getBlock(x, y, z);
}

/** Package spots near the giver: rooftops first (≤ 3), then parks / plazas / parking lots. */
export function pickPackageSpots(plan, x, z, reserved = new Set(), n = 5) {
  const out = [];
  const far = (p, d) => out.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= d);
  const roofs = (plan.rooftops || []).filter((r) => !reserved.has(typeof r.lot === 'object' ? r.lot.id : r.lot))
    .map((r) => ({ x: r.x, y: r.y, z: r.z, label: 'rooftop', d: dist2D(x, z, r.x, r.z) })).filter((r) => r.d < 360 && r.d > 25).sort((a, b) => a.d - b.d);
  for (const r of roofs) { if (out.length >= Math.min(3, n - 2)) break; if (far(r, 25)) out.push(r); }
  const ground = lotSpots(plan, ['park', 'plaza', 'parking']).filter((s) => !reserved.has(s.lot && s.lot.id))
    .map((s) => ({ x: s.x, y: s.y, z: s.z, label: s.lot ? s.lot.type : 'street', d: dist2D(x, z, s.x, s.z) })).filter((s) => s.d > 40 && s.d < 340).sort((a, b) => a.d - b.d);
  for (const s of ground) { if (out.length >= n) break; if (far(s, 35)) out.push(s); }
  // still short: sidewalks along nearby roads
  if (out.length < n && plan.roads && plan.nodes) {
    const R = rng32(Math.floor(x * 31 + z * 17));
    for (let tries = 0; tries < 80 && out.length < n; tries++) {
      const r = plan.roads[Math.floor(R() * plan.roads.length)];
      const a = plan.nodes[r.a], b = plan.nodes[r.b];
      if (!a || !b) continue;
      const t = 0.3 + R() * 0.4;
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const off = r.width / 2 + 1.5;
      const p = { x: a.x + (b.x - a.x) * t - ((b.z - a.z) / L) * off, z: a.z + (b.z - a.z) * t + ((b.x - a.x) / L) * off };
      const d = dist2D(x, z, p.x, p.z);
      if (d < 50 || d > 320 || !far(p, 40)) continue;
      if (typeof plan.isSidewalk === 'function' && !plan.isSidewalk(p.x, p.z)) continue;
      out.push({ x: p.x, y: CL, z: p.z, label: 'sidewalk', d });
    }
  }
  return out.slice(0, n);
}

/** Hit location: a yard spot in the port / industrial zone 60-300 m from the giver, away from shops and givers. */
export function pickHitSpot(plan, x, z) {
  const c = [];
  const nearPoi = (px, pz) => (plan.pois || []).some((p) => dist2D(p.x, p.z, px, pz) < 40);
  for (const l of plan.lots || []) {
    if (!(l.district === 'port' || l.district === 'industrial')) continue;
    const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2;
    const pts = [];
    if (l.entrance) pts.push({ x: l.entrance.x, z: l.entrance.z, yaw: l.entrance.yaw || 0 });
    // 3 m inside the middle of each edge, facing out of the lot
    pts.push({ x: cx + 0.5, z: l.z0 + 3.5, yaw: Math.PI }, { x: cx + 0.5, z: l.z1 - 3.5, yaw: 0 }, { x: l.x0 + 3.5, z: cz + 0.5, yaw: -Math.PI / 2 }, { x: l.x1 - 3.5, z: cz + 0.5, yaw: Math.PI / 2 });
    for (const p of pts) {
      if (plan.isWater(p.x, p.z) || plan.isRoad(p.x, p.z)) continue;
      const d = dist2D(x, z, p.x, p.z);
      if (d < 60 || d > 300 || nearPoi(p.x, p.z)) continue;
      c.push({ x: p.x, y: typeof plan.surfaceY === 'function' ? plan.surfaceY(p.x, p.z) : CL, z: p.z, yaw: p.yaw, d, lot: l });
    }
  }
  c.sort((a, b) => Math.abs(a.d - 150) - Math.abs(b.d - 150));
  if (c[0]) return c[0];
  // fallback: a sidewalk beside a road node 120-260 m away
  let best = null;
  for (const n of plan.nodes || []) {
    const d = dist2D(x, z, n.x, n.z);
    if (d < 120 || d > 260 || nearPoi(n.x, n.z)) continue;
    if (!best || Math.abs(d - 180) < Math.abs(best.d - 180)) best = { x: n.x + 0.5, y: CL, z: n.z + 0.5, yaw: 0, d };
  }
  return best;
}

/** A free standing spot (2 air blocks over solid ground) within `r` m of (x, z) near height y, or null. */
export function findStandSpot(game, x, z, y, r = 8) {
  const w = game && game.world;
  if (!w || typeof w.isSolid !== 'function') return { x, y, z };
  const ok = (px, pz, py) => w.isSolid(Math.floor(px), py - 1, Math.floor(pz)) && !w.isSolid(Math.floor(px), py, Math.floor(pz)) && !w.isSolid(Math.floor(px), py + 1, Math.floor(pz));
  for (let rad = 0; rad <= r; rad += 1) {
    const n = Math.max(1, Math.round(rad * 6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
      for (const dy of [0, 1, -1]) if (ok(px, pz, y + dy)) return { x: Math.floor(px) + 0.5, y: y + dy, z: Math.floor(pz) + 0.5 };
    }
  }
  return null;
}

/** Parking spot for the Joyride car: far from both the giver and the garage. */
export function pickJoyrideSpot(plan, giver, garage) {
  const spots = (plan.parkingSpots || []).map((s) => ({ s, dg: dist2D(giver.x, giver.z, s.x, s.z), dr: dist2D(garage.x, garage.z, s.x, s.z) }));
  let c = spots.filter((e) => e.dg > 140 && e.dg < 420 && e.dr > 180).sort((a, b) => Math.abs(a.dg - 260) - Math.abs(b.dg - 260));
  if (!c.length) c = spots.sort((a, b) => b.dr - a.dr);
  return c.length ? c[0].s : null;
}

// ================================================================================================ factories

const GANG_BOSS_LOOK = { ...LOOKS.gang, shirt: 0xf5c518, pants: 0x111111, hat: 0x111111, shoes: 0xf5c518 };

function joyride(plan, ctx) {
  const garage = poisOfType(plan, 'garage')[0];
  if (!garage || !(plan.parkingSpots || []).length) return null;
  return {
    id: 'joyride', title: 'Joyride', letter: 'J', difficulty: 1, reward: 1500,
    blurb: 'A collector wants a very specific supercar. Steal it and deliver it in one piece.',
    intro: 'Steal the Voxeltron X',
    vehicleName: 'Voxeltron X',
    anchor: districtCenter(plan, 'residential') || { x: garage.x, z: garage.z },
    prepare(giver) {
      const spot = pickJoyrideSpot(plan, giver, garage);
      if (!spot) return false;
      let drop = null;
      for (const s of [9, -9, 13, -13, 6, -6]) { const p = besidePoi(garage, s); if (drivable(plan, p.x, p.z)) { drop = p; break; } }
      if (!drop) drop = { x: garage.x, y: garage.y, z: garage.z };
      const where = districtName(ctx.game, spot.x, spot.z) || 'town';
      this.brief = 'A gold *Voxeltron X* is parked in *' + where + '*. Bring it to the Pay\'n\'Spray lot with at least 50% condition.';
      this.steps = [
        { type: 'enterVehicle', vehicle: 'mission', text: 'Steal the ~b~Voxeltron X~s~ parked in ' + where + '.' },
        { type: 'deliverVehicle', at: drop, radius: 4.5, minHealth: 0.5, text: 'Deliver the ~b~Voxeltron X~s~ to the ~y~Pay\'n\'Spray lot~s~. Keep it above 50%!' },
      ];
      this.setup = (run) => {
        const vs = run.game.vehicles;
        // clear a parked car occupying the spot
        const blocker = vs && typeof vs.findNearest === 'function' ? safe(() => vs.findNearest(spot, 3.5, (v) => v !== vs.playerVehicle && !v.persistent && v.driver !== 'player'), null) : null;
        if (blocker && typeof vs.remove === 'function') safe(() => vs.remove(blocker));
        const v = run.spawnVehicle('supercar', spot.x, spot.y, spot.z, spot.yaw || 0, { parked: true, color: 0xf5c518 });
        if (!v) { run.fail('The car was already gone.'); return; }
        run.vehicle = v;
      };
      this.cleanup = (run, passed) => {
        const v = run.vehicle;
        if (v && !v.destroyed && passed) {
          // the collector takes the car: lock it and let it despawn
          v.locked = true;
          if (run.game.player && run.game.player.inVehicle === v) safe(() => run.game.vehicles.exit({ force: true }));
        }
      };
      this.passNote = (run) => {
        const v = run.vehicle;
        return v ? 'Condition ' + Math.round(Math.max(0, v.health) / Math.max(1, v.maxHealth) * 100) + '%' : '';
      };
      return true;
    },
  };
}

function race(plan, ctx) {
  return {
    id: 'race', title: 'Checkpoint Race', letter: 'R', difficulty: 2, reward: 1600,
    blurb: 'A street race through the city. Hit every checkpoint; beat the gold time for the big payout.',
    intro: 'Hit every checkpoint',
    protectVehicle: false,
    anchor: districtCenter(plan, 'downtown') || { x: 256, z: 256 },
    prepare(giver) {
      const route = buildRaceRoute(plan, giver.x, giver.z, (ctx.seed ^ 0x9e3779b9) >>> 0);
      if (!route) return false;
      const gold = Math.round(route.length / 21 + 4);
      const silver = Math.round(route.length / 15.5 + 6);
      const limit = Math.round(route.length / 10 + 25);
      this.route = route;
      this.gold = gold;
      this.silver = silver;
      this.brief = 'Race through *' + route.points.length + ' checkpoints* (' + Math.round(route.length) + ' m). Gold: *' + fmtClock(gold, 0).replace(/\.\d+$/, '') + '*, silver: *' + fmtClock(silver, 0).replace(/\.\d+$/, '') + '*.';
      this.steps = [
        (run) => (run.game.player && run.game.player.inVehicle ? null : { type: 'enterVehicle', vehicle: 'any', text: run.vehicle ? 'Get in the ~b~race car~s~.' : 'Get a ~b~car~s~. Any car will do.' }),
        { type: 'gotoMarker', at: route.start, radius: 6, vehicle: 'any', stop: true, text: 'Drive to the ~y~start line~s~.' },
        { type: 'raceCheckpoints', points: route.points, gold, silver, timeLimit: limit, text: 'Race through the ~y~checkpoints~s~!' },
      ];
      this.setup = (run) => {
        if (run.game.player && run.game.player.inVehicle) return;
        const v = run.spawnVehicleNear('sports', { x: giver.x, y: giver.y, z: giver.z }, { color: 0xd62f2f });
        if (v) run.vehicle = v;
      };
      this.rewardFor = (run) => {
        const t = run.data.raceTime || Infinity;
        const medal = t <= gold ? 'gold' : t <= silver ? 'silver' : 'bronze';
        run.data.medal = medal;
        return { gold: 1600, silver: 1100, bronze: 700 }[medal];
      };
      this.passNote = (run) => {
        const m = run.data.medal || 'bronze';
        return (m === 'gold' ? '🥇 GOLD' : m === 'silver' ? '🥈 SILVER' : '🥉 BRONZE') + ' · ' + fmtClock(run.data.raceTime || 0, 2);
      };
      return true;
    },
  };
}

function packages(plan, ctx) {
  return {
    id: 'packages', title: 'Package Run', letter: 'P', difficulty: 2, reward: 1200, timeLimit: 240,
    blurb: 'Five packages are stashed on rooftops and in back lots. Grab them all before the time runs out.',
    intro: 'Five packages, four minutes',
    anchor: (() => {
      const r = plan.rooftops || [];
      if (!r.length) return null;
      return { x: r.reduce((s, p) => s + p.x, 0) / r.length, z: r.reduce((s, p) => s + p.z, 0) / r.length };
    })(),
    prepare(giver) {
      const spots = pickPackageSpots(plan, giver.x, giver.z, ctx.reserved, 5);
      if (spots.length < 3) return false;
      const roofs = spots.filter((s) => s.label === 'rooftop').length;
      this.brief = 'Collect *' + spots.length + ' packages* in 4 minutes.' + (roofs ? ' ' + roofs + ' are on rooftops: take the stairs inside the buildings.' : '');
      this.steps = [
        { type: 'collectItems', items: spots.map((s) => ({ x: s.x, y: s.y, z: s.z, label: s.label })), text: (run, st) => 'Collect the ~y~packages~s~ (' + (st.got || 0) + '/' + (st.total || spots.length) + ').' },
      ];
      return true;
    },
  };
}

function demolition(plan, ctx) {
  return {
    id: 'demolition', title: 'Demolition Contract', letter: 'D', difficulty: 2, reward: 2000,
    blurb: 'The city condemned an old building. Blow at least 35% of it to bits with TNT and rockets.',
    intro: 'Bring the house down',
    anchor: districtCenter(plan, 'industrial') || districtCenter(plan, 'oldtown'),
    prepare(giver) {
      const lot = pickDemolitionLot(plan, giver.x, giver.z, ctx.reserved);
      if (!lot) return false;
      ctx.reserved.add(lot.id);
      const where = districtName(ctx.game, (lot.x0 + lot.x1) / 2, (lot.z0 + lot.z1) / 2) || 'town';
      this.lot = lot;
      this.brief = 'Demolish the condemned building in *' + where + '*. You get *8 TNT* (place it, then right-click it with an empty hand) and a *Rocket Launcher*.';
      this.steps = [
        { type: 'destroyBlocks', lot: { x0: lot.x0, z0: lot.z0, x1: lot.x1, z1: lot.z1 }, y0: CL, y1: Math.min(WORLD.HEIGHT - 1, CL + (lot.height || 12) + 10), fraction: 0.35,
          text: 'Demolish ~o~35%~s~ of the ~o~condemned building~s~ in ' + where + '.' },
      ];
      this.setup = (run) => {
        run.give([{ kind: 'block', id: B.TNT, count: 8 }, { kind: 'weapon', id: 'rpg', ammo: 3 }], 'Received *8 TNT* and a *Rocket Launcher* (3 rockets).');
      };
      return true;
    },
  };
}

function diamonds(plan, ctx) {
  const mine = plan.mine;
  if (!mine || !mine.entrance) return null;
  const hints = (mine.ores || []).filter((o) => o.id === B.GOLD_ORE || o.id === B.DIAMOND_ORE);
  if (hints.length < 3) return null;
  return {
    id: 'diamonds', title: 'Diamond Rush', letter: 'M', difficulty: 2, reward: 1800, timeLimit: 420,
    blurb: 'An old prospector swears the mine is loaded. Dig out 3 gold or diamond ores and bring them back.',
    intro: 'Strike it rich',
    anchor: { x: mine.entrance.x, z: mine.entrance.z },
    prepare(giver) {
      const camp = { x: giver.x, y: giver.y, z: giver.z };
      this.brief = 'Mine *3 gold or diamond ores* in Granite Peak Mine and return within 7 minutes. Ores glint through the rock when you are close.';
      this.steps = [
        { type: 'gotoMarker', at: { x: mine.entrance.x, y: mine.entrance.y, z: mine.entrance.z }, radius: 3.5, text: 'Head into ~y~Granite Peak Mine~s~.' },
        { type: 'mineBlocks', ids: [B.GOLD_ORE, B.DIAMOND_ORE], count: 3, hints, text: (run, st) => 'Mine ~y~gold~s~ or ~b~diamond~s~ ore (' + (st.n || 0) + '/3).' },
        { type: 'gotoMarker', at: camp, radius: 2.5, text: 'Bring the haul back to ~y~' + (giver.name || 'the camp') + '~s~.' },
      ];
      this.setup = (run) => {
        run.give([{ kind: 'tool', id: 'pickaxe' }, { kind: 'block', id: B.LAMP, count: 8 }], 'Pickaxe ready. Here are *8 lamps* for the dark tunnels.');
      };
      return true;
    },
  };
}

function hit(plan, ctx) {
  return {
    id: 'hit', title: 'The Hit', letter: 'H', difficulty: 3, reward: 2500,
    blurb: 'A gang boss is running the docks. Take him out (his bodyguards will object), then lose the cops.',
    intro: 'Take out the gang boss',
    anchor: districtCenter(plan, 'port') || districtCenter(plan, 'industrial'),
    prepare(giver) {
      const spot = pickHitSpot(plan, giver.x, giver.z);
      if (!spot) return false;
      const where = districtName(ctx.game, spot.x, spot.z) || 'the docks';
      this.brief = 'The boss (gold shirt) and *3 armed bodyguards* hang out in *' + where + '*. Expect a 2-star wanted level afterwards.';
      this.steps = [
        {
          type: 'killTarget', at: spot, spawnDist: 140,
          text: 'Take out the ~r~gang boss~s~ in ' + where + '.',
          spawn: (run) => {
            const yaw = spot.yaw || 0;
            const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
            const at = (f, r) => {
              const p = { x: spot.x + fx * f + rx * r, y: spot.y, z: spot.z + fz * f + rz * r };
              return findStandSpot(run.game, p.x, p.z, Math.round(p.y), 6) || p;
            };
            const target = run.spawnPed(at(0, 0), { look: GANG_BOSS_LOOK, team: 'gang', weapon: 'pistol', mood: 'calm', health: 250, persistent: true, mode: 'guard', yaw: yaw + Math.PI });
            const guards = [];
            for (const [f, r] of [[-1.5, 2.6], [-1.5, -2.6], [1.8, 0.6]]) {
              const g = run.spawnPed(at(f, r), { look: { ...LOOKS.gang }, team: 'gang', weapon: 'pistol', mood: 'calm', health: 100, persistent: true, mode: 'guard', yaw: yaw + Math.PI + (r > 0 ? 0.5 : -0.5) });
              if (g) guards.push(g);
            }
            return { target, guards };
          },
        },
        { type: 'evadeWanted', level: 2, text: 'Lose the ~b~cops~s~.' },
      ];
      return true;
    },
  };
}

function builder(plan, ctx) {
  return {
    id: 'builder', title: 'Builder', letter: 'B', difficulty: 1, reward: 1200,
    blurb: 'A farmer needs a new shed. Place at least 40 blocks in the marked plot; build it 8 high for a bonus.',
    intro: 'Build something great',
    anchor: (() => {
      const rank = (l) => (l.style === 'farmyard' ? 0 : l.style === 'field' ? 1 : 2);
      const e = (plan.lots || []).filter((l) => l.type === 'empty').sort((a, b) => rank(a) - rank(b))[0];
      return e ? lotCenter(e) : null;
    })(),
    prepare(giver) {
      const plot = pickBuildPlot(plan, giver.x, giver.z, 10);
      if (!plot) return false;
      if (plot.lot) ctx.reserved.add(plot.lot.id);
      this.plot = plot;
      this.brief = 'Place *40 blocks* inside the green plot. Build it *8 blocks tall* for a *$600 bonus*. Materials provided.';
      this.steps = [
        (run) => {
          // pick the clearest patch near the planned plot now that the real voxels are available
          const live = safe(() => findClearPlot(run.game, plan, (plot.x0 + plot.x1) / 2, (plot.z0 + plot.z1) / 2, 10), null) || plot;
          run.data.plot = live;
          return { type: 'placeBlocks', area: live, count: 40, bonusHeight: 8, bonus: 600, text: 'Build in the ~g~plot~s~: place ~y~40 blocks~s~.' };
        },
      ];
      this.setup = (run) => {
        run.give([
          { kind: 'block', id: B.PLANKS, count: 64 }, { kind: 'block', id: B.BRICK, count: 64 },
          { kind: 'block', id: B.GLASS, count: 32 }, { kind: 'block', id: B.LOG, count: 16 },
        ], 'Materials delivered: *planks, bricks, glass and logs*. Select them with [1]-[9] and place with right-click.');
      };
      this.passNote = (run) => (run.data.builtBlocks ? run.data.builtBlocks + ' blocks · ' + run.data.builtHeight + ' high' : '');
      return true;
    },
  };
}

function taxi(plan, ctx) {
  if (!plan.roads || !plan.roads.length) return null;
  return {
    id: 'taxi', title: 'Taxi Driver', letter: 'T', difficulty: 1, reward: 700,
    blurb: 'Fill in for a sick cabbie: drive 3 fares to their destinations. Fast rides earn tips.',
    intro: 'Three fares, no detours',
    vehicleName: 'taxi',
    anchor: (() => { const b = poisOfType(plan, 'beach')[0]; return b ? { x: b.x, z: b.z } : districtCenter(plan, 'bayfront'); })(),
    prepare(giver) {
      this.brief = 'Pick up *3 fares* and drive them where they need to go. The quicker the ride, the bigger the tip. Any taxi works for side jobs too.';
      this.steps = [
        { type: 'enterVehicle', vehicle: 'mission', text: 'Get in the ~b~taxi~s~.' },
        { type: 'taxiFares', count: 3, text: (run, st) => 'Pick up fares (' + (st.fares || 0) + '/3).' },
      ];
      this.setup = (run) => {
        const pl = run.game.player;
        if (pl && pl.inVehicle && pl.inVehicle.type === 'taxi') { run.vehicle = pl.inVehicle; run.vehicle.persistent = true; run.ownVehicle(run.vehicle); return; }
        const v = run.spawnVehicleNear('taxi', { x: giver.x, y: giver.y, z: giver.z });
        if (!v) { run.fail('No taxi available.'); return; }
        run.vehicle = v;
      };
      this.passNote = (run) => (run.data.fareEarnings ? 'Fares ' + fmtMoney(run.data.fareEarnings) : '');
      return true;
    },
  };
}

/** Free-roam taxi side job (not listed): starts automatically while driving any taxi. */
export function taxiSideJob() {
  return {
    id: 'taxi_side', title: 'Taxi Shift', letter: 'T', side: true, reward: 0, vehicleName: 'taxi', vehicleBlip: false,
    steps: [{ type: 'taxiFares', count: Infinity, side: true }],
  };
}

// ================================================================================================ build

const FACTORIES = { joyride, race, packages, demolition, diamonds, hit, builder, taxi };
// most location-constrained first so they get the giver closest to what they need
const ASSIGN_ORDER = ['diamonds', 'builder', 'hit', 'taxi', 'packages', 'demolition', 'race', 'joyride'];

/** Build every available mission definition for the game's plan. */
export function buildMissionDefs(game) {
  const plan = planOf(game);
  if (!plan) return [];
  const ctx = { plan, game, seed: (game && game.seed) || 1, reserved: new Set() };
  let givers = poisOfType(plan, 'mission').slice();
  const spare = ['helipad', 'beach', 'mine'].flatMap((t) => poisOfType(plan, t));
  const defs = {};
  for (const id of ASSIGN_ORDER) {
    let def = null;
    try { def = FACTORIES[id](plan, ctx); } catch (e) { console.warn('[missions] def ' + id, e); def = null; }
    if (!def) continue;
    const anchor = def.anchor || { x: 256, z: 256 };
    const pool = givers.length ? givers : spare;
    if (!pool.length) continue;
    pool.sort((a, b) => dist2D(a.x, a.z, anchor.x, anchor.z) - dist2D(b.x, b.z, anchor.x, anchor.z));
    const giver = pool[0];
    let ok = false;
    try { ok = def.prepare(giver) !== false; } catch (e) { console.warn('[missions] prepare ' + id, e); ok = false; }
    if (!ok) continue;
    pool.splice(0, 1);
    def.giver = giver;
    def.giverName = giver.name || def.title;
    delete def.anchor;
    defs[id] = def;
  }
  return MISSION_ORDER.filter((id) => defs[id]).map((id) => defs[id]);
}
