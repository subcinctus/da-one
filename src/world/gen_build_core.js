// Building toolkit: blueprints are ordered lists of clipped voxel ops in world coordinates.
// A blueprint is built once per lot (pure function of lot + seed); generateChunk runs the ops whose bbox
// overlaps the chunk, so structures spanning chunk borders always agree between neighbours.
import { B } from './blocks.js';
import { makeRng } from '../core/math.js';
import { CL, RY, h3, FACE_DX, FACE_DZ, YAW_TO_FRONT } from './gen_const.js';
import { setv, stampFeature } from './gen_features.js';

export { setv };

/** Fill [x0,x1) x [y0,y1) x [z0,z1) with id, clipped to the chunk. */
export function fillBox(ctx, x0, y0, z0, x1, y1, z1, id) {
  const ox = ctx.ox, oz = ctx.oz, d = ctx.data;
  const ax0 = x0 > ox ? x0 : ox, ax1 = x1 < ox + 16 ? x1 : ox + 16;
  const az0 = z0 > oz ? z0 : oz, az1 = z1 < oz + 16 ? z1 : oz + 16;
  if (ax0 >= ax1 || az0 >= az1) return;
  const ay0 = y0 < 0 ? 0 : y0, ay1 = y1 > 96 ? 96 : y1;
  for (let y = ay0; y < ay1; y++) {
    for (let z = az0; z < az1; z++) {
      const base = ((z - oz) << 4) + (y << 8) - ox;
      for (let x = ax0; x < ax1; x++) d[base + x] = id;
    }
  }
}

/** Replace only cells currently equal to `from` (or any non-air when from < 0) inside the box. */
export function replaceBox(ctx, x0, y0, z0, x1, y1, z1, from, id) {
  const ox = ctx.ox, oz = ctx.oz, d = ctx.data;
  const ax0 = Math.max(x0, ox), ax1 = Math.min(x1, ox + 16);
  const az0 = Math.max(z0, oz), az1 = Math.min(z1, oz + 16);
  if (ax0 >= ax1 || az0 >= az1) return;
  for (let y = Math.max(0, y0); y < Math.min(96, y1); y++) {
    for (let z = az0; z < az1; z++) {
      const base = ((z - oz) << 4) + (y << 8) - ox;
      for (let x = ax0; x < ax1; x++) {
        const k = base + x;
        if (from < 0 ? d[k] !== 0 : d[k] === from) d[k] = id;
      }
    }
  }
}

/**
 * Local frame of a lot seen from its front street. u runs left->right along the facade (as seen by someone
 * standing on the street looking at the building), v runs from the front edge (v=0) into the lot.
 */
export class Frame {
  constructor(lot, face = lot.front) {
    this.lot = lot; this.face = face;
    const w = lot.x1 - lot.x0, d = lot.z1 - lot.z0;
    this.W = face === 0 || face === 2 ? w : d;
    this.D = face === 0 || face === 2 ? d : w;
  }
  /** world x of cell (u,v) */
  x(u, v) {
    const L = this.lot;
    switch (this.face) { case 2: return L.x0 + u; case 0: return L.x1 - 1 - u; case 1: return L.x1 - 1 - v; default: return L.x0 + v; }
  }
  z(u, v) {
    const L = this.lot;
    switch (this.face) { case 2: return L.z1 - 1 - v; case 0: return L.z0 + v; case 1: return L.z1 - 1 - u; default: return L.z0 + u; }
  }
  /** world rect [x0,z0,x1,z1) of local cells u0..u1-1, v0..v1-1 */
  rect(u0, v0, u1, v1) {
    const xa = this.x(u0, v0), xb = this.x(u1 - 1, v1 - 1);
    const za = this.z(u0, v0), zb = this.z(u1 - 1, v1 - 1);
    return [Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb) + 1, Math.max(za, zb) + 1];
  }
  /** continuous world point of local continuous coords */
  px(uf, vf) { const L = this.lot; switch (this.face) { case 2: return L.x0 + uf; case 0: return L.x1 - uf; case 1: return L.x1 - vf; default: return L.x0 + vf; } }
  pz(uf, vf) { const L = this.lot; switch (this.face) { case 2: return L.z1 - vf; case 0: return L.z0 + vf; case 1: return L.z1 - uf; default: return L.z0 + uf; } }
  /** local u of a world coordinate along the facade */
  uOf(wx, wz) {
    const L = this.lot;
    switch (this.face) { case 2: return wx - L.x0; case 0: return L.x1 - 1 - wx; case 1: return L.z1 - 1 - wz; default: return wz - L.z0; }
  }
  /** yaw looking into the lot (toward the back) */
  get yawIn() { return YAW_TO_FRONT[this.face]; }
  /** yaw looking out to the street */
  get yawOut() { return YAW_TO_FRONT[this.face] + Math.PI; }
  get dx() { return FACE_DX[this.face]; }
  get dz() { return FACE_DZ[this.face]; }
}

/** Blueprint: ordered ops + map paint + parking spots + keep-clear sidewalk cells. */
export class BP {
  constructor(lot, seed, P) {
    this.lot = lot; this.P = P; this.ops = []; this.map = []; this.spots = []; this.noprop = [];
    this.rng = makeRng(((lot.seed >>> 0) ^ (seed * 2654435761)) >>> 0);
    this.roofY = CL; this.bbox = [lot.x0, lot.z0, lot.x1, lot.z1];
    this.reserved = null;
    this.wetRects = [];
  }
  op(x0, z0, x1, z1, f) {
    if (x1 <= x0 || z1 <= z0) return;
    this.ops.push({ x0, z0, x1, z1, f });
    const b = this.bbox;
    if (x0 < b[0]) b[0] = x0; if (z0 < b[1]) b[1] = z0; if (x1 > b[2]) b[2] = x1; if (z1 > b[3]) b[3] = z1;
  }
  fill(x0, y0, z0, x1, y1, z1, id) { if (y1 > y0) this.op(x0, z0, x1, z1, (c) => fillBox(c, x0, y0, z0, x1, y1, z1, id)); }
  fillR(r, y0, y1, id) { this.fill(r[0], y0, r[1], r[2], y1, r[3], id); }
  set(x, y, z, id) { this.op(x, z, x + 1, z + 1, (c) => setv(c, x, y, z, id)); }
  feature(f) { const r = f.r + 1; this.op(f.x - r, f.z - r, f.x + r + 1, f.z + r + 1, (c) => stampFeature(c, f)); }
  facade(b, st) { this.op(b.x0, b.z0, b.x1, b.z1, (c) => facade(c, b, st)); this.roofY = Math.max(this.roofY, b.y1); }
  /** register a top-down map rect (roof colour / ground colour) */
  paint(x0, z0, x1, z1, color, h = 0, kind = 'ground') { this.map.push({ x0, z0, x1, z1, color, h, kind }); }
  paintR(r, color, h = 0, kind = 'ground') { this.paint(r[0], r[1], r[2], r[3], color, h, kind); }
  spot(x, z, yaw, tag) { this.spots.push({ x, y: CL, z, yaw, tag }); }
  keepClear(r) { this.noprop.push(r); }
  /** Record the street-side standing point in front of a door at local (u, v) of frame F (for peds / missions). */
  door(F, u, v = 0, w = 1) {
    if (!this.lot || this.lot.id < 0) return;
    this.lot.entrance = { x: F.px(u + w / 2, v - 1.5), y: CL, z: F.pz(u + w / 2, v - 1.5), yaw: F.yawIn };
  }
  /** Record an accessible rooftop standing point (reached by the interior stairs). */
  rooftop(x, y, z) { this.roofPoint = { x: x + 0.5, y, z: z + 0.5, lot: this.lot ? this.lot.id : -1 }; }
  /** Mark ground-level water cells (ponds, pools, fountains) so plan.isWater() reports them. */
  wet(x0, z0, x1, z1) { this.wetRects.push([x0, z0, x1, z1]); }
}

/**
 * Building mass with a window grid.
 * b = {x0,z0,x1,z1,y0,y1}: walls fill y0..y1-1, roof slab at y1-1 (interior), parapet at y1 on the edges.
 * st = { wall, corner, band, win, lit, litP, fh, rows, per, mask, off, fill, roof, parapet, salt, sides }
 *   rows: bitmask over (y-y0)%fh that are window rows; mask: bitmask over (u+off)%per that are window columns.
 *   sides: optional bitmask of facades that get windows (bit f for face f), default all.
 */
export function facade(ctx, b, st) {
  const ox = ctx.ox, oz = ctx.oz, d = ctx.data;
  const ax0 = Math.max(b.x0, ox), ax1 = Math.min(b.x1, ox + 16);
  const az0 = Math.max(b.z0, oz), az1 = Math.min(b.z1, oz + 16);
  if (ax0 >= ax1 || az0 >= az1) return;
  const y0 = b.y0, y1 = Math.min(b.y1, 96), fh = st.fh || 4;
  const sides = st.sides === undefined ? 15 : st.sides;
  const litP = st.litP || 0;
  for (let z = az0; z < az1; z++) {
    for (let x = ax0; x < ax1; x++) {
      const col = (x - ox) + ((z - oz) << 4);
      const ex = x === b.x0 || x === b.x1 - 1, ez = z === b.z0 || z === b.z1 - 1;
      if (!ex && !ez) {
        for (let y = y0; y < y1 - 1; y++) d[col + (y << 8)] = st.fill;
        if (y1 - 1 >= y0) d[col + ((y1 - 1) << 8)] = st.roof;
        continue;
      }
      if (ex && ez) {
        for (let y = y0; y < y1; y++) d[col + (y << 8)] = st.corner;
        if (st.parapet && y1 < 96) d[col + (y1 << 8)] = st.parapet;
        continue;
      }
      const side = ez ? (z === b.z0 ? 0 : 2) : (x === b.x0 ? 3 : 1);
      const u = ez ? x - b.x0 : z - b.z0;
      const cu = (u + (st.off || 0)) % st.per;
      const winCol = ((sides >> side) & 1) && ((st.mask >> cu) & 1);
      const unit = st.per >= 4 ? (u >> 1) : Math.floor((u + (st.off || 0)) / st.per);
      for (let y = y0; y < y1; y++) {
        const ry = y - y0;
        const fy = ry % fh;
        let id;
        if (winCol && ((st.rows >> fy) & 1) && y < y1 - 1) {
          id = litP > 0 && h3(unit * 4 + side, (ry / fh) | 0, b.x0 * 7 + b.z0, st.salt) < litP ? st.lit : st.win;
        } else if (st.band && fy === 0 && ry > 0) id = st.band;
        else id = st.wall;
        d[col + (y << 8)] = id;
      }
      if (st.parapet && y1 < 96) d[col + (y1 << 8)] = st.parapet;
    }
  }
}

/**
 * Hollow interior: floors every fh blocks with flush ceiling lights, optional switchback stairs up to the roof.
 * b = footprint box (same as facade), floors between b.y0 .. b.y1-1 (roof stays).
 */
export function hollow(ctx, b, opts) {
  const ix0 = b.x0 + 1, ix1 = b.x1 - 1, iz0 = b.z0 + 1, iz1 = b.z1 - 1;
  const fh = opts.fh || 4;
  const slab = opts.slab || B.CONCRETE;
  const floorId = opts.floor || slab;
  const ox = ctx.ox, oz = ctx.oz, d = ctx.data;
  const ax0 = Math.max(ix0, ox), ax1 = Math.min(ix1, ox + 16);
  const az0 = Math.max(iz0, oz), az1 = Math.min(iz1, oz + 16);
  const yTop = Math.min(b.y1 - 1, 95); // roof slab y
  const yFrom = opts.fromY !== undefined ? opts.fromY : b.y0;
  const yTo = opts.toY !== undefined ? Math.min(opts.toY, yTop) : yTop;
  if (ax0 < ax1 && az0 < az1) {
    for (let y = yFrom - 1; y < yTo; y++) {
      const k = (y - (b.y0 - 1)) % fh;
      for (let z = az0; z < az1; z++) {
        for (let x = ax0; x < ax1; x++) {
          const i = (x - ox) + ((z - oz) << 4) + (y << 8);
          if (y === b.y0 - 1) { d[i] = floorId; continue; }
          if (k === 0) {
            d[i] = ((x - ix0) % 4 === 2 && (z - iz0) % 4 === 2) ? B.LAMP : slab;
          } else d[i] = B.AIR;
        }
      }
    }
    // furniture: shelves / desks along walls (deterministic)
    if (opts.furnish) {
      const fs = typeof opts.furnish === 'number' ? opts.furnish : 1;
      const sz0 = opts.stairs ? stairZone(b, opts.back || 0) : null;
      for (let y = yFrom; y < yTo; y += fh) {
        for (let z = az0; z < az1; z++) {
          for (let x = ax0; x < ax1; x++) {
            const edge = x === ix0 || x === ix1 - 1 || z === iz0 || z === iz1 - 1;
            if (sz0 && x >= sz0[0] - 1 && x < sz0[2] + 1 && z >= sz0[1] - 1 && z < sz0[3] + 1) continue;
            const r = h3(x, y, z, opts.salt || 1) / fs;
            const i = (x - ox) + ((z - oz) << 4) + (y << 8);
            if (edge && r < 0.2) { d[i] = B.BOOKSHELF; d[i + 256] = r < 0.07 ? B.BOOKSHELF : B.AIR; }
            else if (!edge && r < 0.05 && (x - ix0) % 4 !== 2) d[i] = B.PLANKS;
            else if (!edge && r < 0.09 && d[i - 256] !== B.LAMP) d[i - 256] = B.CARPET_RED;
          }
        }
      }
    }
  }
  if (opts.stairs) {
    // switchback stairs along the back wall: lane 0 / lane 1 alternate per storey
    const back = opts.back || 0;
    const cellXZ = stairMapper(b, back);
    const alongLen = (back === 0 || back === 2) ? ix1 - ix0 : iz1 - iz0;
    const laneLen = (back === 0 || back === 2) ? iz1 - iz0 : ix1 - ix0;
    if (alongLen >= 6 && laneLen >= 3) {
      const steps = fh - 1;
      for (let n = 0; ; n++) {
        const yb = b.y0 - 1 + n * fh;
        if (yb + fh > yTop) break;
        const lane = n % 2;
        for (let i = 0; i < steps; i++) {
          const t = lane === 0 ? 1 + i : steps - i;
          const [x, z] = cellXZ(t, lane);
          for (let yy = yb + 1; yy <= yb + fh; yy++) setv(ctx, x, yy, z, B.AIR);
          setv(ctx, x, yb + 1 + i, z, opts.stair || B.PLANKS);
        }
        // landing stays solid, headroom above it clear; approach cell of the next flight clear too
        const [lx, lz] = cellXZ(lane === 0 ? steps + 1 : 0, lane);
        setv(ctx, lx, yb + fh, lz, slab);
        if (yb + fh < yTop) for (let yy = yb + fh + 1; yy <= Math.min(yb + fh + 2, yTop - 1); yy++) setv(ctx, lx, yy, lz, B.AIR);
        const [sx0, sz0] = cellXZ(0, 0);
        if (n === 0) for (let yy = yb + 1; yy <= yb + 2; yy++) setv(ctx, sx0, yy, sz0, B.AIR);
      }
    }
  }
}

/** Maps (t along the back wall, lane 0/1 away from it) to interior world cells for a stairwell on side `back`. */
export function stairMapper(b, back) {
  const ix0 = b.x0 + 1, ix1 = b.x1 - 1, iz0 = b.z0 + 1, iz1 = b.z1 - 1;
  switch (back) {
    case 2: return (t, lane) => [ix0 + t, iz1 - 1 - lane];
    case 3: return (t, lane) => [ix0 + lane, iz0 + t];
    case 1: return (t, lane) => [ix1 - 1 - lane, iz0 + t];
    default: return (t, lane) => [ix0 + t, iz0 + lane];
  }
}

/** World rect [x0,z0,x1,z1) covered by a stairwell on side `back` (for keeping rooftop clutter / furniture away). */
export function stairZone(b, back) {
  const m = stairMapper(b, back);
  const [ax, az] = m(0, 0), [bx, bz] = m(5, 1);
  return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx) + 1, Math.max(az, bz) + 1];
}

/** Rooftop clutter: AC units, vents, water tower, antenna, stair housing. Returns nothing, adds ops. */
export function roofDetails(bp, r, y, kinds, avoid) {
  const [x0, z0, x1, z1] = r;
  const w = x1 - x0, d = z1 - z0;
  if (w < 4 || d < 4) return;
  const rng = bp.rng;
  const free = (ax, az, bx, bz) => {
    if (!avoid) return true;
    return bx <= avoid[0] || ax >= avoid[2] || bz <= avoid[1] || az >= avoid[3];
  };
  for (const k of kinds) {
    for (let tries = 0; tries < 6; tries++) {
      if (k === 'ac') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 4)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 4));
        if (!free(ax, az, ax + 2, az + 2)) continue;
        bp.fill(ax, y, az, ax + 2, y + 1, az + 2, B.METAL);
        bp.set(ax, y + 1, az, B.CONCRETE_DARK);
        break;
      } else if (k === 'vent') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 2)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 2));
        if (!free(ax, az, ax + 1, az + 1)) continue;
        bp.fill(ax, y, az, ax + 1, y + 2, az + 1, B.METAL);
        break;
      } else if (k === 'tower' && w >= 6 && d >= 6) {
        // classic wooden water tower on legs
        const ax = x0 + 1 + Math.floor(rng() * (w - 5)), az = z0 + 1 + Math.floor(rng() * (d - 5));
        if (!free(ax, az, ax + 3, az + 3)) continue;
        for (const [lx, lz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) bp.fill(ax + lx, y, az + lz, ax + lx + 1, y + 3, az + lz + 1, B.LOG);
        bp.fill(ax, y + 3, az, ax + 3, y + 6, az + 3, B.PLANKS);
        bp.fill(ax + 1, y + 6, az + 1, ax + 2, y + 7, az + 2, B.PLANKS);
        bp.fill(ax, y + 4, az, ax + 3, y + 5, az + 3, B.METAL);
        break;
      } else if (k === 'antenna') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 2)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 2));
        if (!free(ax, az, ax + 1, az + 1)) continue;
        const hh = 4 + Math.floor(rng() * 5);
        bp.fill(ax, y, az, ax + 1, Math.min(95, y + hh), az + 1, B.METAL);
        if (y + hh < 96) bp.set(ax, Math.min(95, y + hh), az, B.NEON_PINK);
        break;
      } else if (k === 'housing') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 5)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 4));
        if (!free(ax, az, ax + 3, az + 3)) continue;
        bp.fill(ax, y, az, ax + 3, y + 3, az + 3, B.CONCRETE_DARK);
        bp.fill(ax + 1, y, az, ax + 2, y + 2, az + 1, B.METAL);
        break;
      } else if (k === 'solar') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 5)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 4));
        if (!free(ax, az, ax + 4, az + 3)) continue;
        bp.fill(ax, y, az, ax + 4, y + 1, az + 3, B.SOLAR);
        break;
      } else if (k === 'garden') {
        const ax = x0 + 1 + Math.floor(rng() * Math.max(1, w - 5)), az = z0 + 1 + Math.floor(rng() * Math.max(1, d - 5));
        if (!free(ax, az, ax + 4, az + 4)) continue;
        bp.fill(ax, y, az, ax + 4, y + 1, az + 4, B.HEDGE);
        bp.fill(ax + 1, y, az + 1, ax + 3, y + 1, az + 3, B.GRASS);
        bp.set(ax + 1, y + 1, az + 1, B.FLOWER_RED);
        bp.set(ax + 2, y + 1, az + 2, B.FLOWER_YELLOW);
        break;
      }
    }
  }
}

/** Flat rooftop helipad: dark pad, hazard ring, white H, corner lights. r = [x0,z0,x1,z1] (>= 9x9) */
export function helipad(bp, r, y) {
  const [x0, z0, x1, z1] = r;
  const cx = Math.floor((x0 + x1) / 2), cz = Math.floor((z0 + z1) / 2);
  const rad = Math.min(x1 - x0, z1 - z0) / 2 - 0.5;
  bp.op(x0, z0, x1, z1, (c) => {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const dd = Math.hypot(x + 0.5 - (x0 + x1) / 2, z + 0.5 - (z0 + z1) / 2);
        let id = B.CONCRETE_DARK;
        if (dd > rad - 1 && dd <= rad) id = B.HAZARD;
        setv(c, x, y, z, id);
      }
    }
    // H
    for (let k = -2; k <= 2; k++) { setv(c, cx - 1, y, cz + k, B.WOOL_WHITE); setv(c, cx + 1, y, cz + k, B.WOOL_WHITE); }
    setv(c, cx, y, cz, B.WOOL_WHITE);
    setv(c, x0, y, z0, B.LAMP); setv(c, x1 - 1, y, z0, B.LAMP); setv(c, x0, y, z1 - 1, B.LAMP); setv(c, x1 - 1, y, z1 - 1, B.LAMP);
  });
}

/**
 * Ground-floor storefront on the front facade of footprint fp (local frame F, footprint local u0..u1, front at v=fv).
 * opts: { wall, glass, sign, awning:[a,b], doorU, doorW, floor, interiorDepth, shelf }
 */
export function storefront(bp, F, u0, u1, fv, opts) {
  const glass = opts.glass || B.GLASS;
  const doorU = opts.doorU, doorW = opts.doorW || 2;
  const wall = opts.wall;
  const depth = opts.interiorDepth || 6;
  // interior shop space (3 high) behind the glass
  const inner = F.rect(u0 + 1, fv + 1, u1 - 1, fv + 1 + depth);
  bp.fillR(inner, CL, CL + 3, B.AIR);
  bp.fillR(inner, RY, RY + 1, opts.floor || B.TILE_WHITE);
  // facade row
  for (let u = u0 + 1; u < u1 - 1; u++) {
    const x = F.x(u, fv), z = F.z(u, fv);
    const isDoor = u >= doorU && u < doorU + doorW;
    const pillar = !isDoor && (u - u0) % 4 === 0;
    if (isDoor) { bp.fill(x, CL, z, x + 1, CL + 2, z + 1, B.AIR); bp.set(x, CL + 2, z, glass); }
    else if (pillar) bp.fill(x, CL, z, x + 1, CL + 3, z + 1, wall);
    else bp.fill(x, CL, z, x + 1, CL + 3, z + 1, glass);
    bp.set(x, CL + 3, z, wall);
    // sign band above the awning
    if (opts.sign && u > u0 + 1 && u < u1 - 2) bp.set(x, CL + 4, z, (u % 2 === 0 || !opts.sign2) ? opts.sign : opts.sign2);
    // awning over the building-side sidewalk column
    if (opts.awning && !opts.noAwning) {
      const ax = F.x(u, fv - 1), az = F.z(u, fv - 1);
      bp.set(ax, CL + 3, az, opts.awning[(u - u0) % 2]);
    }
  }
  // interior: lights, shelves, counter
  for (let v = fv + 2; v < fv + depth; v += 3) {
    for (let u = u0 + 2; u < u1 - 2; u += 3) bp.set(F.x(u, v), CL + 3, F.z(u, v), B.LAMP);
  }
  if (opts.shelf !== 0) {
    const shelf = opts.shelf || B.BOOKSHELF;
    for (let u = u0 + 1; u < u1 - 1; u++) {
      const x = F.x(u, fv + depth), z = F.z(u, fv + depth);
      if (depth > 2) bp.fill(x, CL, z, x + 1, CL + 2, z + 1, shelf);
    }
    const cu = doorU + doorW + 1;
    if (cu + 2 < u1 - 1) {
      const r = F.rect(cu, fv + 2, cu + 2, fv + 3);
      bp.fillR(r, CL, CL + 1, opts.counter || B.PLANKS);
    }
  }
}

/** Cylinder (solid or shell) of blocks: centre (cx,cz) + radius r, y0..y1. */
export function cylinder(bp, cx, cz, r, y0, y1, id, shellOnly = false, inner = B.AIR) {
  const R = Math.ceil(r);
  bp.op(Math.floor(cx - R), Math.floor(cz - R), Math.floor(cx + R) + 1, Math.floor(cz + R) + 1, (c) => {
    for (let z = Math.floor(cz - R); z <= Math.floor(cz + R); z++) {
      for (let x = Math.floor(cx - R); x <= Math.floor(cx + R); x++) {
        const dd = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
        if (dd > r) continue;
        const shell = dd > r - 1;
        for (let y = y0; y < y1; y++) setv(c, x, y, z, shellOnly && !shell ? inner : id);
      }
    }
  });
}

/** Which sides of the lot face a sidewalk/road (bitmask by face index). */
export function roadSides(P, lot) {
  let m = 0;
  const probe = (x, z) => P.isSidewalk(x, z) || P.isRoad(x, z);
  const mx = (lot.x0 + lot.x1) >> 1, mz = (lot.z0 + lot.z1) >> 1;
  if (probe(mx, lot.z0 - 1)) m |= 1;
  if (probe(lot.x1, mz)) m |= 2;
  if (probe(mx, lot.z1)) m |= 4;
  if (probe(lot.x0 - 1, mz)) m |= 8;
  return m;
}

/** Shade a colour (0xRRGGBB) by factor. */
export function shade(c, f) {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
}
export function mix(c1, c2, t) {
  const r = Math.round(((c1 >> 16) & 255) * (1 - t) + ((c2 >> 16) & 255) * t);
  const g = Math.round(((c1 >> 8) & 255) * (1 - t) + ((c2 >> 8) & 255) * t);
  const b = Math.round((c1 & 255) * (1 - t) + (c2 & 255) * t);
  return (r << 16) | (g << 8) | b;
}
