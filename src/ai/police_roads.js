// Road-graph knowledge for police drivers (POLICE agent): all-pairs shortest paths over plan.nodes/roads
// (Floyd-Warshall, built once), nearest-road queries, route planning that respects the car's heading, spawn points
// on roads in a distance band, roadblock sites ahead of a fleeing car and search waypoints.
// Pure math over the plan: importable from Node for unit tests (see .smoke/police/roads_test.mjs).

const UTURN_COST = 45;      // metres of penalty for routes that start by turning around
const INF = 1e9;

export class RoadNet {
  /** @param plan the city plan (§4.1) */
  constructor(plan) {
    this.plan = plan;
    const nodes = (plan && plan.nodes) || [];
    const roads = (plan && plan.roads) || [];
    this.nodes = nodes;
    this.roads = roads;
    const n = nodes.length;
    this.n = n;
    // node id -> index (ids are expected to be indices, but do not rely on it)
    this.idx = new Map();
    nodes.forEach((nd, i) => this.idx.set(nd.id, i));
    // road geometry
    this.geo = roads.map((r) => {
      const A = nodes[this.idx.get(r.a)], B = nodes[this.idx.get(r.b)];
      if (!A || !B) return null;
      const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
      return { road: r, a: this.idx.get(r.a), b: this.idx.get(r.b), ax: A.x, az: A.z, bx: B.x, bz: B.z, len,
        dx: (B.x - A.x) / len, dz: (B.z - A.z) / len, width: r.width || 8, lanes: r.lanes || 1, speed: r.speedLimit || 14,
        kind: r.kind || 'street' };
    });
    this.totalLen = 0;
    for (const g of this.geo) if (g) this.totalLen += g.len;
    // adjacency
    this.adj = Array.from({ length: n }, () => []);
    for (let k = 0; k < this.geo.length; k++) {
      const g = this.geo[k];
      if (!g) continue;
      this.adj[g.a].push({ to: g.b, road: k, len: g.len });
      this.adj[g.b].push({ to: g.a, road: k, len: g.len });
    }
    // all-pairs shortest paths (n ~ 100 -> ~1e6 relaxations, a few ms once)
    const dist = new Float64Array(n * n).fill(INF);
    const next = new Int32Array(n * n).fill(-1);
    for (let i = 0; i < n; i++) { dist[i * n + i] = 0; next[i * n + i] = i; }
    for (const g of this.geo) {
      if (!g) continue;
      if (g.len < dist[g.a * n + g.b]) {
        dist[g.a * n + g.b] = dist[g.b * n + g.a] = g.len;
        next[g.a * n + g.b] = g.b; next[g.b * n + g.a] = g.a;
      }
    }
    for (let k = 0; k < n; k++) {
      const kn = k * n;
      for (let i = 0; i < n; i++) {
        const dik = dist[i * n + k];
        if (dik >= INF) continue;
        const inn = i * n;
        for (let j = 0; j < n; j++) {
          const d = dik + dist[kn + j];
          if (d < dist[inn + j]) { dist[inn + j] = d; next[inn + j] = next[inn + k]; }
        }
      }
    }
    this.dist = dist;
    this.next = next;
    this._near = { geo: null, t: 0, x: 0, z: 0, d: 0, k: -1 };
  }

  get ok() { return this.n > 1 && this.geo.length > 0; }

  /** Shortest road distance between node indices (Infinity if disconnected). */
  nodeDist(i, j) { const d = this.dist[i * this.n + j]; return d >= INF ? Infinity : d; }

  /** Node index path i -> j (inclusive) into out (array). Empty when unreachable. */
  nodePath(i, j, out = []) {
    out.length = 0;
    if (i < 0 || j < 0 || this.next[i * this.n + j] < 0) return out;
    let c = i;
    out.push(c);
    for (let guard = 0; c !== j && guard < this.n + 2; guard++) {
      c = this.next[c * this.n + j];
      if (c < 0) { out.length = 0; return out; }
      out.push(c);
    }
    return out;
  }

  /**
   * Closest point on the centre line of any road. out = {geo, t (metres from node a), x, z, d (distance), k}.
   * Returns null when the plan has no roads.
   */
  nearest(x, z, out = this._near) {
    let best = null, bd = Infinity, bt = 0, bk = -1;
    for (let k = 0; k < this.geo.length; k++) {
      const g = this.geo[k];
      if (!g) continue;
      let t = (x - g.ax) * g.dx + (z - g.az) * g.dz;
      if (t < 0) t = 0; else if (t > g.len) t = g.len;
      const qx = g.ax + g.dx * t, qz = g.az + g.dz * t;
      const d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
      if (d < bd) { bd = d; best = g; bt = t; bk = k; }
    }
    if (!best) return null;
    out.geo = best; out.t = bt; out.k = bk;
    out.x = best.ax + best.dx * bt; out.z = best.az + best.dz * bt;
    out.d = Math.sqrt(bd);
    return out;
  }

  /** Lane-centre offset (to the right of travel) of the innermost lane of a road. */
  static laneOffset(geo, lane = 0) {
    if (!geo) return 2;
    return (lane + 0.5) * geo.width / (2 * Math.max(1, geo.lanes));
  }

  /**
   * Plan a route from (x, z) heading `yaw` to (tx, tz) along the road graph.
   * Returns flat waypoints [x0, z0, x1, z1, ...] on road centre lines (the final target appended) into out.
   * Each waypoint is a node except the last two (target projected on its road, then the target itself).
   */
  route(x, z, yaw, tx, tz, out = []) {
    out.length = 0;
    if (!this.ok) { out.push(tx, tz); return out; }
    const s = { ...this.nearest(x, z) };
    const e = { ...this.nearest(tx, tz) };
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    // off-road start: drive to the road first
    if (s.d > s.geo.width / 2 + 6) out.push(s.x, s.z);
    if (s.geo === e.geo) {
      out.push(e.x, e.z, tx, tz);
      return out;
    }
    let best = null, bestCost = Infinity;
    const sg = s.geo, eg = e.geo;
    const startOpts = [[sg.a, s.t, -1, sg.b], [sg.b, sg.len - s.t, 1, sg.a]];
    const endOpts = [[eg.a, e.t], [eg.b, eg.len - e.t]];
    for (const [sn, sc, sdir, other] of startOpts) {
      // driving toward node a means moving along -dir
      const align = (sg.dx * fx + sg.dz * fz) * sdir;
      const uturn = align < -0.25 && s.d < sg.width / 2 + 6 ? UTURN_COST : 0;
      const adj = this.adj[sn] || [];
      for (const [en, ec] of endOpts) {
        if (sn === en) {
          const c = sc + uturn + ec;
          if (c < bestCost) { bestCost = c; best = [sn, -1, en]; }
          continue;
        }
        // leave the node by any road except doubling back along the start road (that is the other option)
        for (const ed of adj) {
          if (ed.to === other && adj.length > 1) continue;
          const mid = this.nodeDist(ed.to, en);
          if (!Number.isFinite(mid)) continue;
          const c = sc + uturn + ed.len + mid + ec;
          if (c < bestCost) { bestCost = c; best = [sn, ed.to, en]; }
        }
      }
    }
    if (!best) { out.push(tx, tz); return out; }
    out.push(this.nodes[best[0]].x, this.nodes[best[0]].z);
    if (best[1] >= 0) {
      const path = this.nodePath(best[1], best[2], this._path || (this._path = []));
      for (const i of path) out.push(this.nodes[i].x, this.nodes[i].z);
    }
    // the last node may already be the projected end point's road end: skip a duplicate end point
    out.push(e.x, e.z, tx, tz);
    return out;
  }

  /**
   * Random point on a road between minD and maxD from (px, pz) for which accept(x, z, yaw) is true. The point sits
   * in the lane heading toward the player. Returns {x, z, yaw, geo} or null after `tries` attempts.
   */
  spawnPoint(px, pz, minD, maxD, accept = null, tries = 80) {
    if (!this.ok || !(this.totalLen > 0)) return null;
    for (let i = 0; i < tries; i++) {
      // pick a road weighted by length
      let r = Math.random() * this.totalLen, g = null;
      for (const q of this.geo) { if (!q) continue; r -= q.len; if (r <= 0) { g = q; break; } }
      if (!g) g = this.geo.find((q) => q);
      if (!g || g.len < 14) continue;
      // keep clear of intersections (cars must not spawn mid-turn)
      const m = g.len > 44 ? 16 : 7;
      const t = m + Math.random() * (g.len - 2 * m);
      const cx = g.ax + g.dx * t, cz = g.az + g.dz * t;
      const d = Math.hypot(cx - px, cz - pz);
      if (d < minD || d > maxD) continue;
      // travel direction: toward the player along the road
      const toward = (px - cx) * g.dx + (pz - cz) * g.dz >= 0 ? 1 : -1;
      const ddx = g.dx * toward, ddz = g.dz * toward;
      const off = RoadNet.laneOffset(g, 0);
      const x = cx - ddz * off, z = cz + ddx * off; // right-hand normal of (ddx, ddz) is (-ddz, ddx)
      const yaw = Math.atan2(ddx, ddz);
      if (accept && !accept(x, z, yaw)) continue;
      return { x, z, yaw, geo: g };
    }
    return null;
  }

  /**
   * A site for a roadblock on the road the player is driving along, between minD and maxD ahead of them
   * (following straight continuations through intersections). heading = unit (hx, hz) of travel.
   * Returns {x, z, yaw (along the road, travel direction), width} or null.
   */
  roadblockSite(px, pz, hx, hz, minD, maxD) {
    if (!this.ok) return null;
    const s = this.nearest(px, pz, {});
    if (!s || s.d > s.geo.width / 2 + 1.5) return null;
    let g = s.geo;
    const along = g.dx * hx + g.dz * hz;
    if (Math.abs(along) < 0.7) return null;
    let dir = along > 0 ? 1 : -1;
    let t = s.t;                      // metres from node a
    let travelled = 0;
    for (let hop = 0; hop < 4 && g; hop++) {
      const remain = dir > 0 ? g.len - t : t;
      // usable stretch on this road: keep 10 m clear of intersections
      const lo = Math.max(minD - travelled, 10), hi = Math.min(maxD - travelled, remain - 10);
      if (hi >= lo) {
        const dd = lo + Math.random() * (hi - lo) * 0.5;
        const tt = dir > 0 ? t + dd : t - dd;
        return { x: g.ax + g.dx * tt, z: g.az + g.dz * tt, yaw: Math.atan2(g.dx * dir, g.dz * dir), width: g.width, geo: g };
      }
      travelled += remain;
      if (travelled > maxD) return null;
      // continue straight through the node at the end
      const node = dir > 0 ? g.b : g.a;
      const ddx = g.dx * dir, ddz = g.dz * dir;
      let nextG = null, nextDir = 1;
      for (const e of this.adj[node] || []) {
        const q = this.geo[e.road];
        if (!q || q === g) continue;
        const qdir = q.a === node ? 1 : -1;
        if (q.dx * qdir * ddx + q.dz * qdir * ddz > 0.95) { nextG = q; nextDir = qdir; break; }
      }
      if (!nextG) return null;
      g = nextG; dir = nextDir; t = dir > 0 ? 0 : g.len;
    }
    return null;
  }

  /** A random road point within radius r of (cx, cz) (search patrols). Falls back to a plain random offset. */
  searchPoint(cx, cz, r, out = { x: 0, z: 0 }) {
    if (this.ok) {
      for (let i = 0; i < 24; i++) {
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
        const q = this.nearest(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, {});
        if (q && Math.hypot(q.x - cx, q.z - cz) <= r * 1.1) { out.x = q.x; out.z = q.z; return out; }
      }
    }
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
    out.x = cx + Math.cos(a) * rr; out.z = cz + Math.sin(a) * rr;
    return out;
  }

  /** Next node for a patrol car arriving at node index `at` from node `from` (no U-turns unless dead end). */
  patrolNext(at, from) {
    const opts = (this.adj[at] || []).filter((e) => e.to !== from);
    const list = opts.length ? opts : (this.adj[at] || []);
    if (!list.length) return -1;
    // mild preference to keep going straight
    const A = this.nodes[from], B = this.nodes[at];
    let total = 0;
    const w = list.map((e) => {
      const C = this.nodes[e.to];
      let k = 1;
      if (A && B && C) {
        const d1x = B.x - A.x, d1z = B.z - A.z, d2x = C.x - B.x, d2z = C.z - B.z;
        const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
        if ((d1x * d2x + d1z * d2z) / (l1 * l2) > 0.9) k = 1.8;
      }
      total += k;
      return k;
    });
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i].to; }
    return list[list.length - 1].to;
  }
}
