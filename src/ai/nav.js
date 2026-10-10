// NPC navigation data, built once from the city plan (ARCHITECTURE.md §4.1, §Traffic, §Peds). NPC agent.
//
//   const nav = getNav(plan);
//   nav.lanes   straight lane centre-line segments, one per road / direction / lane (right-hand traffic).
//               Endpoints are inset from intersections (crossing road half width + stop-line / turning margin)
//               so cars stop before the crosswalk and have room to turn.
//   nav.conns   turning connections through nodes (cubic Bezier arcs, straight lines for straight-on).
//   nav.junctions[nodeId]  intersection info: box (asphalt square), crosswalk flag, degree.
//   nav.walk    sidewalk graph for pedestrians: corner vertices, 'walk' edges along the sidewalks (offset
//               width/2 + sidewalkWidth/2 on both sides of every city road), 'wrap' edges around corners where an
//               arm is missing and 'cross' edges over painted crosswalks.
//
// Pure data + math (no THREE, no DOM): importable from Node for unit tests (see npc_selftest.js).

const SQRT_K = 0.5523; // cubic Bezier handle factor for a quarter circle (left turns: wide, smooth arcs)
const INNER_K = 0.8;   // right (inner) turns: handles closer to the corner so the arc does not cut the kerb

// ------------------------------------------------------------------------------------------------ polyline paths

/** Polyline in the XZ plane with arc-length parametrisation. Used for lanes, turns and walking edges. */
export class PolyPath {
  /** pts: flat [x0, z0, x1, z1, ...] (at least 2 points). */
  constructor(pts) {
    const n = pts.length >> 1;
    this.n = n;
    this.pts = Float64Array.from(pts);
    this.cum = new Float64Array(n);
    let L = 0;
    for (let i = 1; i < n; i++) {
      L += Math.hypot(this.pts[i * 2] - this.pts[i * 2 - 2], this.pts[i * 2 + 1] - this.pts[i * 2 - 1]);
      this.cum[i] = L;
    }
    this.len = L;
  }

  get x0() { return this.pts[0]; }
  get z0() { return this.pts[1]; }
  get x1() { return this.pts[this.n * 2 - 2]; }
  get z1() { return this.pts[this.n * 2 - 1]; }

  _seg(s) {
    const cum = this.cum, n = this.n;
    if (s <= 0 || n === 2) return 0;
    if (s >= this.len) return n - 2;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    return lo;
  }

  /**
   * Point + unit tangent at arc length s into out {x, z, tx, tz}. Beyond the ends the path is extrapolated along
   * the end tangents (handy for look-ahead past the end of a route).
   */
  sample(s, out) {
    const i = this._seg(s), p = this.pts;
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
    const sl = this.cum[i + 1] - this.cum[i] || 1e-6;
    const tx = (bx - ax) / sl, tz = (bz - az) / sl;
    const u = s - this.cum[i];
    out.x = ax + tx * u; out.z = az + tz * u; out.tx = tx; out.tz = tz;
    return out;
  }

  /**
   * Closest arc length to (x, z). Not clamped past the end of the last segment (s > len means "beyond the end")
   * nor before the start (s < 0). out.d = lateral signed distance (+ = right of the tangent), out.s = arc length.
   */
  project(x, z, out) {
    const p = this.pts, n = this.n;
    let best = Infinity, bs = 0, bd = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      const sl = this.cum[i + 1] - this.cum[i] || 1e-6;
      const tx = (bx - ax) / sl, tz = (bz - az) / sl;
      let u = (x - ax) * tx + (z - az) * tz;
      const first = i === 0, last = i === n - 2;
      if (u < 0 && !first) u = 0;
      if (u > sl && !last) u = sl;
      const qx = ax + tx * u, qz = az + tz * u;
      const d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d2 < best) {
        best = d2;
        bs = this.cum[i] + u;
        // right normal of tangent (tx, tz) is (-tz, tx)
        bd = (x - qx) * -tz + (z - qz) * tx;
      }
    }
    out.s = bs; out.d = bd;
    return out;
  }
}

function bezierPts(x0, z0, x1, z1, x2, z2, x3, z3, segs) {
  const out = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3, a * z0 + b * z1 + c * z2 + d * z3);
  }
  return out;
}

const cross2 = (ax, az, bx, bz) => ax * bz - az * bx;
const isCityKind = (k) => k === 'street' || k === 'avenue';

// ------------------------------------------------------------------------------------------------ road lanes

/**
 * Build lanes + turning connections from plan.nodes / plan.roads.
 * Lane: {id, kind:'lane', road, dir (+1 a->b / -1 b->a), index, lanes, from, to, x0,z0,x1,z1, dx,dz, len, speed,
 *        offset, axis (0 = along x, 1 = along z), path, out: Conn[], inn: Conn[], siblings: Lane[], deadEnd, city}
 * Conn: {id, kind:'conn', from: Lane, to: Lane, node, turn: 'straight'|'left'|'right', path, len, speed, radius}
 */
export function buildRoadNav(plan) {
  const nodes = plan.nodes || [], roads = plan.roads || [];
  const roadDir = (r) => {
    const A = nodes[r.a], B = nodes[r.b];
    const L = Math.hypot(B.x - A.x, B.z - A.z) || 1;
    return { dx: (B.x - A.x) / L, dz: (B.z - A.z) / L, L };
  };
  const rd = roads.map(roadDir);
  // ---- junction info
  const junctions = nodes.map((n) => {
    let hx = 0, hz = 0, city = false;
    for (const ri of n.edges) {
      const r = roads[ri], d = rd[ri];
      if (isCityKind(r.kind)) city = true;
      // a road running along z spans x over its width (and vice versa)
      if (Math.abs(d.dz) >= Math.abs(d.dx)) hx = Math.max(hx, r.width / 2); else hz = Math.max(hz, r.width / 2);
    }
    const deg = n.edges.length;
    return {
      id: n.id, x: n.x, z: n.z, deg, city, junction: deg >= 3, crosswalk: deg >= 3 && city,
      hx, hz, box: { x0: n.x - hx, z0: n.z - hz, x1: n.x + hx, z1: n.z + hz }, lanesIn: [], lanesOut: [], conns: [],
    };
  });
  /** Half width of the roads crossing `ri` at node n. */
  const halfCross = (n, ri) => {
    const d = rd[ri];
    let e = 0;
    for (const oi of n.edges) {
      if (oi === ri) continue;
      const o = rd[oi];
      if (Math.abs(d.dx * o.dx + d.dz * o.dz) < 0.7) e = Math.max(e, roads[oi].width / 2);
    }
    return e;
  };
  /** Distance from the node centre to where the lane begins/ends. */
  const inset = (n, ri) => {
    const j = junctions[n.id];
    if (j.deg === 1) return 2;                         // dead end: stay on the asphalt
    const e = halfCross(n, ri);
    if (e === 0) return 0;                             // straight continuation
    if (j.junction) return e + (j.city ? 4 : 6);       // stop line just before the crosswalk / highway junction
    return e + (j.city ? 4 : 10);                      // bend: room for a smooth curve (wider on highways)
  };

  const lanes = [];
  for (const r of roads) {
    const d = rd[r.id];
    for (const dir of [1, -1]) {
      const A = dir > 0 ? nodes[r.a] : nodes[r.b], B = dir > 0 ? nodes[r.b] : nodes[r.a];
      const dx = d.dx * dir, dz = d.dz * dir;
      const rx = -dz, rz = dx; // right-hand normal
      let insA = inset(A, r.id), insB = inset(B, r.id);
      const maxIns = Math.max(0, d.L - 2);
      if (insA + insB > maxIns) { const k = maxIns / (insA + insB); insA *= k; insB *= k; }
      const sibs = [];
      for (let i = 0; i < r.lanes; i++) {
        const off = (i + 0.5) * r.width / (2 * r.lanes);
        const x0 = A.x + dx * insA + rx * off, z0 = A.z + dz * insA + rz * off;
        const x1 = B.x - dx * insB + rx * off, z1 = B.z - dz * insB + rz * off;
        const lane = {
          id: lanes.length, kind: 'lane', road: r, roadId: r.id, dir, index: i, lanes: r.lanes, from: A.id, to: B.id,
          x0, z0, x1, z1, dx, dz, len: Math.hypot(x1 - x0, z1 - z0), speed: r.speedLimit, offset: off,
          axis: Math.abs(dx) > Math.abs(dz) ? 0 : 1, path: new PolyPath([x0, z0, x1, z1]), out: [], inn: [], siblings: sibs,
          deadEnd: B.edges.length === 1, fromDeadEnd: A.edges.length === 1, city: isCityKind(r.kind), insetA: insA, insetB: insB,
        };
        sibs.push(lane);
        lanes.push(lane);
        junctions[B.id].lanesIn.push(lane);
        junctions[A.id].lanesOut.push(lane);
      }
    }
  }

  // ---- turning connections
  const conns = [];
  for (const j of junctions) {
    for (const L of j.lanesIn) {
      for (const M of j.lanesOut) {
        if (M.roadId === L.roadId) continue; // no U-turns
        const dot = L.dx * M.dx + L.dz * M.dz;
        const cr = cross2(L.dx, L.dz, M.dx, M.dz);
        let turn;
        if (dot > 0.7) turn = 'straight';
        else if (dot < -0.7) continue;
        else turn = cr > 0 ? 'right' : 'left';
        if (turn === 'straight' || !j.junction) {
          // straight on, or a bend (concentric arcs never conflict): lane i -> lane i
          if (M.index !== Math.min(L.index, M.lanes - 1)) continue;
        } else if (turn === 'right') {
          if (L.index !== L.lanes - 1 || M.index !== M.lanes - 1) continue; // right turns from the kerb lane
        } else if (L.index !== 0 || M.index !== 0) continue;                 // left turns from the inner lane
        const x0 = L.x1, z0 = L.z1, x3 = M.x0, z3 = M.z0;
        let pts, radius;
        if (turn === 'straight') {
          const lat = Math.abs((x3 - x0) * -L.dz + (z3 - z0) * L.dx);
          if (lat < 0.05) pts = [x0, z0, x3, z3];
          else {
            const h = Math.hypot(x3 - x0, z3 - z0) / 3;
            pts = bezierPts(x0, z0, x0 + L.dx * h, z0 + L.dz * h, x3 - M.dx * h, z3 - M.dz * h, x3, z3, 8);
          }
          radius = Infinity;
        } else {
          // corner = intersection of the two lane lines: P0 + t*dL = P3 - u*dM
          const den = cross2(L.dx, L.dz, M.dx, M.dz);
          const ex = x3 - x0, ez = z3 - z0;
          const t = cross2(ex, ez, M.dx, M.dz) / den;
          const u = cross2(L.dx, L.dz, ex, ez) / den;
          const k = turn === 'right' ? INNER_K : SQRT_K;
          const h0 = k * Math.max(0.5, t), h1 = k * Math.max(0.5, u);
          pts = bezierPts(x0, z0, x0 + L.dx * h0, z0 + L.dz * h0, x3 - M.dx * h1, z3 - M.dz * h1, x3, z3, 12);
          radius = Math.max(1, Math.min(t, u));
        }
        const path = new PolyPath(pts);
        const speed = turn === 'straight' ? Math.min(L.speed, M.speed) : Math.max(4.5, Math.min(10, Math.sqrt(5 * radius)));
        const c = { id: conns.length, kind: 'conn', from: L, to: M, node: j.id, turn, path, len: path.len, speed, radius };
        conns.push(c);
        L.out.push(c);
        M.inn.push(c);
        j.conns.push(c);
      }
    }
  }
  return { lanes, conns, junctions };
}

// ------------------------------------------------------------------------------------------------ sidewalks

/**
 * Sidewalk graph. Vertex: {id, node, qx, qz, x, z, edges: Edge[]}.
 * Edge: {id, kind: 'walk'|'wrap'|'cross', a, b (vertices), ax, az, bx, bz, len, dx, dz (unit a->b),
 *        nx, nz (unit normal pointing away from the road / along the crossed arm), node, roadId}
 */
export function buildWalkNav(plan) {
  const nodes = plan.nodes || [], roads = plan.roads || [];
  const sw = plan.sidewalkWidth || 3;
  const swOff = sw / 2;
  const verts = [];
  const vmap = new Map(); // nodeId*4 + quadrant index -> vertex
  const qIndex = (qx, qz) => (qx > 0 ? 1 : 0) + (qz > 0 ? 2 : 0);

  // arms of each node: N (-z), S (+z), E (+x), W (-x)
  const arms = nodes.map((n) => {
    const a = { N: null, S: null, E: null, W: null, city: false };
    for (const ri of n.edges) {
      const r = roads[ri];
      const o = nodes[r.a === n.id ? r.b : r.a];
      const dx = o.x - n.x, dz = o.z - n.z;
      const k = Math.abs(dz) >= Math.abs(dx) ? (dz < 0 ? 'N' : 'S') : (dx > 0 ? 'E' : 'W');
      if (!a[k] || r.width > a[k].width) a[k] = r;
      if (isCityKind(r.kind)) a.city = true;
    }
    return a;
  });
  const junction = nodes.map((n) => n.edges.length >= 3 && arms[n.id].city);

  const vertex = (n, qx, qz) => {
    const key = n.id * 4 + qIndex(qx, qz);
    let v = vmap.get(key);
    if (v) return v;
    const A = arms[n.id];
    const vert = (qz < 0 ? A.N : A.S) || (qz < 0 ? A.S : A.N);
    const hori = (qx > 0 ? A.E : A.W) || (qx > 0 ? A.W : A.E);
    const hv = vert ? vert.width / 2 : 0, hh = hori ? hori.width / 2 : 0;
    v = { id: verts.length, node: n.id, qx, qz, x: n.x + qx * (hv + swOff), z: n.z + qz * (hh + swOff), edges: [] };
    verts.push(v);
    vmap.set(key, v);
    return v;
  };

  const edges = [];
  const addEdge = (a, b, kind, nx, nz, node, roadId) => {
    if (a === b) return null;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.5) return null;
    const e = {
      id: edges.length, kind, a, b, ax: a.x, az: a.z, bx: b.x, bz: b.z, len, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len,
      nx, nz, node, roadId,
    };
    edges.push(e);
    return e;
  };

  // walk edges along both sides of every city road
  for (const r of roads) {
    if (!isCityKind(r.kind)) continue;
    let P = nodes[r.a], Q = nodes[r.b];
    const vertical = Math.abs(Q.z - P.z) >= Math.abs(Q.x - P.x);
    if (vertical ? Q.z < P.z : Q.x < P.x) { const t = P; P = Q; Q = t; }
    if (vertical) {
      addEdge(vertex(P, -1, 1), vertex(Q, -1, -1), 'walk', -1, 0, -1, r.id);
      addEdge(vertex(P, 1, 1), vertex(Q, 1, -1), 'walk', 1, 0, -1, r.id);
    } else {
      addEdge(vertex(P, 1, -1), vertex(Q, -1, -1), 'walk', 0, -1, -1, r.id);
      addEdge(vertex(P, 1, 1), vertex(Q, -1, 1), 'walk', 0, 1, -1, r.id);
    }
  }
  // corner connections inside each city node
  const QUADS = [
    // [qa, qb, arm between them, normal (direction of that arm)]
    [[-1, -1], [1, -1], 'N', 0, -1],
    [[1, -1], [1, 1], 'E', 1, 0],
    [[1, 1], [-1, 1], 'S', 0, 1],
    [[-1, 1], [-1, -1], 'W', -1, 0],
  ];
  for (const n of nodes) {
    const A = arms[n.id];
    if (!A.city) continue;
    for (const [qa, qb, arm, nx, nz] of QUADS) {
      const va = vmap.get(n.id * 4 + qIndex(qa[0], qa[1]));
      const vb = vmap.get(n.id * 4 + qIndex(qb[0], qb[1]));
      if (!va && !vb) continue;
      const a = va || vertex(n, qa[0], qa[1]);
      const b = vb || vertex(n, qb[0], qb[1]);
      if (A[arm]) { if (junction[n.id]) addEdge(a, b, 'cross', nx, nz, n.id, A[arm].id); }
      else addEdge(a, b, 'wrap', nx, nz, n.id, -1);
    }
  }

  // validate against the plan rasters (drop anything not actually on a sidewalk / crosswalk)
  const ok = [];
  for (const e of edges) {
    if (validateEdge(plan, e)) ok.push(e);
  }
  for (const e of ok) { e.a.edges.push(e); e.b.edges.push(e); }
  const vertsOk = verts.filter((v) => v.edges.length > 0);
  ok.forEach((e, i) => { e.id = i; });
  vertsOk.forEach((v, i) => { v.id = i; });
  return { verts: vertsOk, edges: ok, dropped: edges.length - ok.length, grid: buildEdgeGrid(ok) };
}

function validateEdge(plan, e) {
  if (typeof plan.isSidewalk !== 'function') return true;
  const steps = Math.max(2, Math.ceil(e.len));
  if (e.kind === 'cross') {
    if (!plan.isSidewalk(e.ax, e.az) || !plan.isSidewalk(e.bx, e.bz)) return false;
    let road = 0;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const x = e.ax + (e.bx - e.ax) * t, z = e.az + (e.bz - e.az) * t;
      if (plan.isRoad(x, z)) road++;
      else if (!plan.isSidewalk(x, z)) return false;
    }
    return road > 0;
  }
  let bad = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = e.ax + (e.bx - e.ax) * t, z = e.az + (e.bz - e.az) * t;
    if (!plan.isSidewalk(x, z)) bad++;
  }
  return bad === 0;
}

const GRID_CELL = 32;
function buildEdgeGrid(edges) {
  const cells = new Map();
  for (const e of edges) {
    const x0 = Math.floor(Math.min(e.ax, e.bx) / GRID_CELL), x1 = Math.floor(Math.max(e.ax, e.bx) / GRID_CELL);
    const z0 = Math.floor(Math.min(e.az, e.bz) / GRID_CELL), z1 = Math.floor(Math.max(e.az, e.bz) / GRID_CELL);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const k = cz * 1024 + cx;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(e);
    }
  }
  return cells;
}

/**
 * Nearest sidewalk edge to (x, z) within maxDist. Returns {edge, t (0..len along a->b), d (distance), px, pz} or null.
 * kinds: optional Set of edge kinds to accept (default: walk + wrap).
 */
export function nearestWalkEdge(walk, x, z, maxDist = 40, out = {}, kinds = null) {
  const cx = Math.floor(x / GRID_CELL), cz = Math.floor(z / GRID_CELL);
  const r = Math.max(1, Math.ceil(maxDist / GRID_CELL));
  let best = null, bd = maxDist * maxDist, bt = 0, bpx = 0, bpz = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const l = walk.grid.get((cz + dz) * 1024 + (cx + dx));
    if (!l) continue;
    for (const e of l) {
      if (kinds ? !kinds.has(e.kind) : e.kind === 'cross') continue;
      let t = (x - e.ax) * e.dx + (z - e.az) * e.dz;
      t = t < 0 ? 0 : t > e.len ? e.len : t;
      const px = e.ax + e.dx * t, pz = e.az + e.dz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bd) { bd = d2; best = e; bt = t; bpx = px; bpz = pz; }
    }
  }
  if (!best) return null;
  out.edge = best; out.t = bt; out.d = Math.sqrt(bd); out.px = bpx; out.pz = bpz;
  return out;
}

// ------------------------------------------------------------------------------------------------ cache

const CACHE = new WeakMap();

/** Navigation for a plan (built once, cached per plan object). */
export function getNav(plan) {
  if (!plan) return null;
  let nav = CACHE.get(plan);
  if (!nav) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const rn = buildRoadNav(plan);
    const walk = buildWalkNav(plan);
    nav = {
      lanes: rn.lanes, conns: rn.conns, junctions: rn.junctions, walk,
      spawnLanes: rn.lanes.filter((l) => !l.deadEnd && l.len > 6),
      ms: 0,
    };
    nav.ms = Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0);
    CACHE.set(plan, nav);
  }
  return nav;
}

/**
 * Nearest lane to (x, z) whose direction is within ~60° of yaw (if yaw is a number). Returns {lane, s, d} or null.
 */
export function nearestLane(nav, x, z, yaw = null, maxDist = 30, out = {}) {
  let best = null, bd = maxDist, bs = 0;
  const fx = yaw === null ? 0 : Math.sin(yaw), fz = yaw === null ? 0 : Math.cos(yaw);
  for (const l of nav.lanes) {
    if (yaw !== null && l.dx * fx + l.dz * fz < 0.5) continue;
    let t = (x - l.x0) * l.dx + (z - l.z0) * l.dz;
    const tc = t < 0 ? 0 : t > l.len ? l.len : t;
    const px = l.x0 + l.dx * tc, pz = l.z0 + l.dz * tc;
    const d = Math.hypot(x - px, z - pz) + (l.deadEnd ? 4 : 0);
    if (d < bd) { bd = d; best = l; bs = t; }
  }
  if (!best) return null;
  out.lane = best; out.s = bs; out.d = bd;
  return out;
}
