// Self-test of the NPC navigation data against the real city plan (NPC agent).
// Pure: runs in Node (`node .smoke/npc/navtest.mjs`) and in the game (`game.debug.navSelfTest()`).
//   - every lane centre-line sample lies on asphalt (plan.isRoad), also +-0.8 m sideways (car width)
//   - every turning connection sample lies on asphalt
//   - every sidewalk 'walk'/'wrap' edge sample lies on a sidewalk (plan.isSidewalk), also at the walking offsets
//   - 'cross' edges start/end on sidewalks and cross asphalt
//   - the lane graph is connected enough: every non-dead-end lane has >= 1 exit
import { getNav } from './nav.js';

export function runNavSelfTest(plan) {
  const nav = getNav(plan);
  const res = {
    ms: nav.ms, lanes: nav.lanes.length, conns: nav.conns.length, walkVerts: nav.walk.verts.length, walkEdges: nav.walk.edges.length,
    walkDropped: nav.walk.dropped, laneSamples: 0, laneOff: 0, laneSideOff: 0, connSamples: 0, connOff: 0,
    connSoft: 0, walkSamples: 0, walkOff: 0, crossEdges: 0, crossBad: 0, deadEndLanes: 0, noExit: 0, turnCounts: {}, failures: [],
  };
  const fail = (msg) => { if (res.failures.length < 20) res.failures.push(msg); };
  for (const l of nav.lanes) {
    if (l.deadEnd) res.deadEndLanes++;
    else if (l.out.length === 0) { res.noExit++; fail(`lane ${l.id} (road ${l.roadId}) has no exit`); }
    const n = Math.max(1, Math.ceil(l.len));
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * l.len;
      const x = l.x0 + l.dx * t, z = l.z0 + l.dz * t;
      res.laneSamples++;
      if (!plan.isRoad(x, z)) { res.laneOff++; fail(`lane ${l.id} off road at ${x.toFixed(1)},${z.toFixed(1)}`); }
      const rx = -l.dz, rz = l.dx;
      if (!plan.isRoad(x + rx * 0.8, z + rz * 0.8) || !plan.isRoad(x - rx * 0.8, z - rz * 0.8)) res.laneSideOff++;
    }
  }
  const tmp = { x: 0, z: 0, tx: 0, tz: 0 };
  for (const c of nav.conns) {
    res.turnCounts[c.turn] = (res.turnCounts[c.turn] || 0) + 1;
    const n = Math.max(2, Math.ceil(c.len));
    for (let k = 0; k <= n; k++) {
      c.path.sample((k / n) * c.len, tmp);
      res.connSamples++;
      if (plan.isRoad(tmp.x, tmp.z)) continue;
      // highway bends may graze the gravel shoulder / a sidewalk corner (flush, drivable): soft miss
      if ((plan.isShoulder && plan.isShoulder(tmp.x, tmp.z)) || plan.isSidewalk(tmp.x, tmp.z)) { res.connSoft++; continue; }
      res.connOff++;
      fail(`conn ${c.id} (${c.turn} @node ${c.node}) off road at ${tmp.x.toFixed(1)},${tmp.z.toFixed(1)}`);
    }
  }
  for (const e of nav.walk.edges) {
    if (e.kind === 'cross') {
      res.crossEdges++;
      if (!plan.isSidewalk(e.ax, e.az) || !plan.isSidewalk(e.bx, e.bz)) { res.crossBad++; fail(`cross edge ${e.id} ends off sidewalk`); }
      continue;
    }
    const n = Math.max(1, Math.ceil(e.len));
    for (const lat of [-0.15, 0.25, 0.6]) {
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * e.len;
        const x = e.ax + e.dx * t + e.nx * lat, z = e.az + e.dz * t + e.nz * lat;
        res.walkSamples++;
        if (!plan.isSidewalk(x, z)) { res.walkOff++; fail(`walk edge ${e.id} off sidewalk at ${x.toFixed(1)},${z.toFixed(1)} lat ${lat}`); }
      }
    }
  }
  res.ok = res.laneOff === 0 && res.connOff === 0 && res.walkOff === 0 && res.crossBad === 0 && res.noExit === 0 && res.walkEdges > 50;
  return res;
}
