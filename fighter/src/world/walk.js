// Walkable space: room floors (rects / discs), the start area and corridors, with closed gates cutting
// corridors off. Pure math, no THREE, no per-call allocations (one tiny record per distinct position object).
//
// clampPosition remembers where each position object was last, so a fighter can never be pushed through a
// closed gate (a step whose segment crosses a closed gate line is refused / projected back) while genuine
// teleports (spawns, revives: a jump >= 1.5 m) are accepted.
import { GATE_THICK } from './layout.js';

const R_NOMINAL = 0.35;      // default fighter radius
const CAM_MARGIN = 0.75;     // camera may leave the floor by this much (into the prop band)
const TELEPORT = 1.5;        // jumps larger than this are teleports, not gate crossings

export class Walkable {
  /** @param layout result of buildLayout() */
  constructor(layout) {
    this.layout = layout;
    this.regions = [];
    this.memory = new WeakMap();
    this.blocking = [];
    const camM = layout.spec?.camMargin ?? CAM_MARGIN;
    for (const a of layout.areas) {
      const reg = {
        area: a, kind: a.kind, disc: a.shape === 'disc',
        // base walk rect (rect areas) / disc
        minX: a.floor.minX, maxX: a.floor.maxX, minZ: a.floor.minZ, maxZ: a.floor.maxZ,
        cx: a.disc ? a.disc.cx : 0, cz: a.disc ? a.disc.cz : 0, r: a.disc ? a.disc.rFloor : 0,
        // effective (gate-clipped) rect, updated by refresh()
        eMinZ: a.floor.minZ, eMaxZ: a.floor.maxZ,
        // camera region
        cMinX: 0, cMaxX: 0, cMinZ: 0, cMaxZ: 0, cR: 0, ceMinZ: 0, ceMaxZ: 0,
      };
      if (a.kind === 'corridor') {
        reg.cMinX = a.x - a.w / 2 + 0.5; reg.cMaxX = a.x + a.w / 2 - 0.5;
        reg.cMinZ = a.walk.minZ; reg.cMaxZ = a.walk.maxZ;
      } else if (reg.disc) {
        reg.cR = Math.min(a.disc.rFloor + camM, a.disc.rWall - 0.35);
      } else {
        const m = Math.min(camM, a.band - 0.3);
        reg.cMinX = a.floor.minX - m; reg.cMaxX = a.floor.maxX + m;
        reg.cMinZ = a.floor.minZ - m; reg.cMaxZ = a.floor.maxZ + m;
      }
      reg.ceMinZ = reg.cMinZ; reg.ceMaxZ = reg.cMaxZ;
      this.regions.push(reg);
    }
    this.refresh();
  }

  /** Recompute gate clipping. Call after any gate's `blocking` changes. */
  refresh() {
    const R = this.regions;
    for (const g of R) {
      if (g.kind !== 'corridor') continue;
      const c = g.area;
      g.eMinZ = c.gateA && c.gateA.blocking ? c.gateA.z + GATE_THICK / 2 : c.walk.minZ;
      g.eMaxZ = c.gateB && c.gateB.blocking ? c.gateB.z - GATE_THICK / 2 : c.walk.maxZ;
      g.ceMinZ = c.gateA && c.gateA.blocking ? c.gateA.z + GATE_THICK / 2 + 0.25 : g.cMinZ;
      g.ceMaxZ = c.gateB && c.gateB.blocking ? c.gateB.z - GATE_THICK / 2 - 0.25 : g.cMaxZ;
    }
    this.blocking.length = 0;
    for (const gt of this.layout.gates) if (gt.blocking) this.blocking.push(gt);
  }

  /** Does the step (x0,z0) -> (x1,z1) cross the line of a closed gate? (gates span X at z = gate.z) */
  crossesClosedGate(x0, z0, x1, z1) {
    const B = this.blocking;
    for (let i = 0; i < B.length; i++) {
      const g = B[i];
      const a = z0 - g.z, b = z1 - g.z;
      if (!(a * b < 0)) continue; // strictly changes side
      const t = a / (a - b);
      const x = x0 + (x1 - x0) * t;
      if (Math.abs(x - g.x) <= g.w / 2 + 0.6) return true;
    }
    return false;
  }

  _contains(g, x, z, r) {
    if (g.disc) { const dx = x - g.cx, dz = z - g.cz, rr = g.r - r; return rr > 0 && dx * dx + dz * dz <= rr * rr; }
    return x >= g.minX + r && x <= g.maxX - r && z >= g.eMinZ + r && z <= g.eMaxZ - r;
  }

  /** Distance² from (x,z) to its projection into region g; writes the projection into this._px/_pz. */
  _project(g, x, z, r) {
    if (g.disc) {
      const dx = x - g.cx, dz = z - g.cz, d = Math.hypot(dx, dz), rr = Math.max(0, g.r - r);
      if (d <= rr) { this._px = x; this._pz = z; return 0; }
      const k = d > 1e-6 ? Math.max(0, rr - 1e-4) / d : 0; // land just inside (float safety)
      this._px = g.cx + dx * k; this._pz = g.cz + dz * k;
    } else {
      let lo = g.minX + r, hi = g.maxX - r;
      this._px = lo > hi ? (g.minX + g.maxX) / 2 : Math.max(lo, Math.min(x, hi));
      lo = g.eMinZ + r; hi = g.eMaxZ - r;
      this._pz = lo > hi ? (g.eMinZ + g.eMaxZ) / 2 : Math.max(lo, Math.min(z, hi));
    }
    const ex = this._px - x, ez = this._pz - z;
    return ex * ex + ez * ez;
  }

  /**
   * Keep `pos` ({x, z}, modified in place) inside walkable space. Returns pos.
   * A step may never cross a closed gate; jumps >= 1.5 m (spawns, revives, debug) are teleports and accepted.
   */
  clamp(pos, radius = R_NOMINAL) {
    if (!pos) return pos;
    const R = this.regions;
    const x = pos.x, z = pos.z;
    if (!(x === x && z === z)) return pos; // NaN guard
    const rec = this.memory.get(pos);
    let step = false; // a short move from a known position: gate rules apply
    if (rec) { const dx = x - rec.x, dz = z - rec.z; step = dx * dx + dz * dz < TELEPORT * TELEPORT; }
    const guard = step && this.blocking.length > 0;
    for (let i = 0; i < R.length; i++) {
      if (!this._contains(R[i], x, z, radius)) continue;
      if (guard && this.crossesClosedGate(rec.x, rec.z, x, z)) break;
      this._remember(pos, i, x, z, rec);
      return pos;
    }
    // project into the nearest region reachable without crossing a closed gate
    let best = -1, bestD = Infinity, bx = x, bz = z;
    for (let i = 0; i < R.length; i++) {
      const d = this._project(R[i], x, z, radius);
      if (d >= bestD) continue;
      const px = this._px, pz = this._pz;
      if (guard && this.crossesClosedGate(rec.x, rec.z, px, pz)) continue;
      bestD = d; best = i; bx = px; bz = pz;
    }
    if (best < 0 && rec) { bx = rec.x; bz = rec.z; best = rec.region; } // nowhere legal: stay put
    if (best >= 0) { pos.x = bx; pos.z = bz; this._remember(pos, best, bx, bz, rec); }
    return pos;
  }

  _remember(pos, region, x, z, rec) {
    if (typeof pos !== 'object') return;
    if (!rec) { rec = { region, x, z }; try { this.memory.set(pos, rec); } catch (e) { return; } }
    rec.region = region; rec.x = x; rec.z = z;
  }

  /** Is (x, z) inside walkable space (gates respected)? radius optional. */
  isWalkable(x, z, radius = 0) {
    for (let i = 0; i < this.regions.length; i++) if (this._contains(this.regions[i], x, z, radius)) return true;
    return false;
  }

  /** Area record ({kind:'room'|'corridor'|'start', ...}) whose walls contain (x, z), or null. */
  areaAt(x, z) {
    const A = this.layout.areas;
    let fallback = null;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      if (a.kind === 'corridor') {
        const w = a.walk;
        if (x >= w.minX && x <= w.maxX && z >= a.zA && z <= a.zB) return a;
        continue;
      }
      if (a.disc) {
        const dx = x - a.disc.cx, dz = z - a.disc.cz;
        if (dx * dx + dz * dz <= a.disc.rWall * a.disc.rWall) fallback = fallback || a;
      } else if (x >= a.wall.minX && x <= a.wall.maxX && z >= a.wall.minZ && z <= a.wall.maxZ) fallback = fallback || a;
    }
    return fallback;
  }

  /** Nearest area to (x, z) (by distance to its wall rect), never null. */
  nearestArea(x, z) {
    const a = this.areaAt(x, z);
    if (a) return a;
    const A = this.layout.areas;
    let best = A[0], bd = Infinity;
    for (let i = 0; i < A.length; i++) {
      const ar = A[i];
      const w = ar.wall;
      const dx = Math.max(w.minX - x, 0, x - w.maxX), dz = Math.max(w.minZ - z, 0, z - w.maxZ);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = ar; }
    }
    return best;
  }

  /** Room (contract object) containing (x, z) within its walls, or null (corridors / start / outside). */
  roomAt(x, z) {
    const a = this.areaAt(x, z);
    return a && a.kind === 'room' ? a.room : null;
  }

  _inCam(x, z) {
    const R = this.regions;
    for (let i = 0; i < R.length; i++) {
      const g = R[i];
      if (g.disc) { const dx = x - g.cx, dz = z - g.cz; if (dx * dx + dz * dz <= g.cR * g.cR) return true; }
      else if (x >= g.cMinX && x <= g.cMaxX && z >= g.ceMinZ && z <= g.ceMaxZ) return true;
    }
    return false;
  }

  /**
   * Camera spring-arm against the room bounds: fraction (0..1) of the segment from (px,pz) to (cx,cz)
   * that stays inside camera space (a pivot just outside, e.g. hugging a corridor wall, may enter it first).
   */
  cameraClip(px, pz, cx, cz) {
    const dx = cx - px, dz = cz - pz, len = Math.hypot(dx, dz);
    if (len < 1e-4) return 1;
    let entered = this._inCam(px, pz);
    const steps = Math.min(60, Math.ceil(len / 0.08));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this._inCam(px + dx * t, pz + dz * t)) entered = true;
      else if (entered || t * len > 0.8) return Math.max(0, (i - 1) / steps);
    }
    return 1;
  }

  /** Ceiling height above (x, z) (Infinity outdoors). */
  ceilingAt(x, z) {
    const a = this.areaAt(x, z);
    return a ? a.ceil : Infinity;
  }
}
