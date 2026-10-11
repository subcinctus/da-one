// Shared building blocks for chapter dressing: wall sides with door openings, corridor shells, ceilings,
// placement helpers that keep doorways clear. Everything writes into MeshBuilders (merged per room).

/** Side descriptor of a rect area: { axis, line, from, to, nx, nz, openings }. side: minX|maxX|minZ|maxZ */
export function side(area, s) {
  const w = area.wall;
  switch (s) {
    case 'minZ': return { s, axis: 'x', line: w.minZ, from: w.minX, to: w.maxX, nx: 0, nz: -1, openings: area.openings.minZ };
    case 'maxZ': return { s, axis: 'x', line: w.maxZ, from: w.minX, to: w.maxX, nx: 0, nz: 1, openings: area.openings.maxZ };
    case 'minX': return { s, axis: 'z', line: w.minX, from: w.minZ, to: w.maxZ, nx: -1, nz: 0, openings: area.openings.minX };
    default: return { s, axis: 'z', line: w.maxX, from: w.minZ, to: w.maxZ, nx: 1, nz: 0, openings: area.openings.maxX };
  }
}
export const SIDES = ['minZ', 'maxZ', 'minX', 'maxX'];

/** Solid spans of [from, to] minus the opening intervals (each [a, b]). */
export function spans(from, to, openings = []) {
  const out = [];
  let cur = from;
  const sorted = [...openings].sort((a, b) => a[0] - b[0]);
  for (const [a, b] of sorted) {
    if (a > cur) out.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
  }
  if (cur < to) out.push([cur, to]);
  return out.filter(([a, b]) => b - a > 0.01);
}

/**
 * Box along a side between params a..b along the wall, from inner face depth d0 to d1 (outward positive),
 * y from y0 to y1. Converts wall-local coordinates to a world box.
 */
export function sideBox(b, sd, a, bb, d0, d1, y0, y1, color, opts = null) {
  if (sd.axis === 'x') {
    const z0 = sd.line + sd.nz * d0, z1 = sd.line + sd.nz * d1;
    b.boxMM(a, y0, Math.min(z0, z1), bb, y1, Math.max(z0, z1), color, opts);
  } else {
    const x0 = sd.line + sd.nx * d0, x1 = sd.line + sd.nx * d1;
    b.boxMM(Math.min(x0, x1), y0, a, Math.max(x0, x1), y1, bb, color, opts);
  }
}

/** World point at parameter `u` along a side, `d` metres inward from the wall line. */
export function sidePoint(sd, u, d) {
  return sd.axis === 'x' ? { x: u, z: sd.line - sd.nz * d } : { x: sd.line - sd.nx * d, z: u };
}
/** Yaw that faces INTO the room from a side (an object's +Z pointing inward). */
export function sideYawIn(sd) { return Math.atan2(-sd.nx, -sd.nz); }

/**
 * Plain wall run along a side: solid spans + lintels over openings.
 * opts: { h, t, color, doorH, lintel, skirting, skirtH, bandColor, bandH }
 */
export function wallSide(b, area, s, opts) {
  const sd = side(area, s);
  const t = opts.t ?? 0.3, h = opts.h;
  const ext = sd.axis === 'x' ? t : 0; // X-running walls extend over the corners
  const parts = spans(sd.from - ext, sd.to + ext, sd.openings);
  for (const [a, c] of parts) {
    sideBox(b, sd, a, c, 0, t, 0, h, opts.color);
    if (opts.wainscot) sideBox(b, sd, a, c, -0.02, 0, 0, opts.wainscotH ?? 1.1, opts.wainscot);
    if (opts.trim) sideBox(b, sd, a, c, -0.035, 0, (opts.wainscotH ?? 1.1) - 0.02, (opts.wainscotH ?? 1.1) + 0.05, opts.trim);
    if (opts.skirting) sideBox(b, sd, a, c, -0.03, 0, 0, opts.skirtH ?? 0.12, opts.skirting);
  }
  if (opts.doorH !== undefined) {
    for (const [a, c] of sd.openings) sideBox(b, sd, a - 0.01, c + 0.01, 0, t, opts.doorH, h, opts.lintel ?? opts.color);
  }
  return sd;
}

/** True when (x, z) lies within `m` metres of a doorway's clear strip (corridor extended through the band). */
export function inDoorway(area, x, z, m = 0.6) {
  const cIn = area.corridorIn, cOut = area.corridorOut;
  for (const c of [cIn, cOut]) {
    if (!c) continue;
    if (Math.abs(x - c.x) < c.w / 2 + m) {
      const zz0 = Math.min(c.walk.minZ, c.zA) - m, zz1 = Math.max(c.walk.maxZ, c.zB) + m;
      if (z > zz0 && z < zz1) return true;
    }
  }
  return false;
}

/**
 * Evenly spaced slots along a side, `d` m inward, skipping doorways. Returns [{x, z, u, yaw}].
 * yaw faces into the room.
 */
export function slots(area, s, spacing, d, margin = 0.6, endPad = 0.4) {
  const sd = side(area, s);
  const out = [];
  const from = sd.from + area.band * 0.5 + endPad, to = sd.to - area.band * 0.5 - endPad;
  const n = Math.max(1, Math.floor((to - from) / spacing));
  const step = (to - from) / n;
  for (let i = 0; i < n; i++) {
    const u = from + step * (i + 0.5);
    const p = sidePoint(sd, u, d);
    if (inDoorway(area, p.x, p.z, margin)) continue;
    out.push({ x: p.x, z: p.z, u, yaw: sideYawIn(sd), sd });
  }
  return out;
}

/** Corridor shell: floor, two side walls, optional ceiling. opts: { h, t, floor(x,z)->colour, wall, ceil, ceilColor } */
export function corridorShell(b, c, opts) {
  const t = opts.t ?? 0.3, h = opts.h;
  const x0 = c.x - c.w / 2, x1 = c.x + c.w / 2;
  if (opts.floorFn) b.floor(x0, c.zA, x1, c.zB, 0, opts.cell ?? 0.5, opts.floorFn, opts.shade);
  if (opts.wall) {
    b.boxMM(x0 - t, 0, c.zA - 0.01, x0, h, c.zB + 0.01, opts.wall);
    b.boxMM(x1, 0, c.zA - 0.01, x1 + t, h, c.zB + 0.01, opts.wall);
    if (opts.wainscot) {
      b.boxMM(x0, 0, c.zA, x0 + 0.02, opts.wainscotH ?? 1.1, c.zB, opts.wainscot);
      b.boxMM(x1 - 0.02, 0, c.zA, x1, opts.wainscotH ?? 1.1, c.zB, opts.wainscot);
    }
  }
  const g0 = b.glowK;
  if (opts.ceilGlow) b.glow(opts.ceilGlow);
  if (opts.ceil) b.boxMM(x0 - t, opts.ceil, c.zA - 0.3, x1 + t, opts.ceil + 0.25, c.zB + 0.3, opts.ceilColor ?? opts.wall, { bottom: true });
  b.glow(g0);
}

/** Ceiling slab over a rect with rectangular holes (skylights). holes: [{minX,maxX,minZ,maxZ}] */
export function ceiling(b, r, y, thick, color, holes = []) {
  // split into strips along Z around holes (holes assumed non-overlapping in Z bands per X range: simple grid split)
  const xs = [r.minX, r.maxX], zs = [r.minZ, r.maxZ];
  for (const h of holes) { xs.push(h.minX, h.maxX); zs.push(h.minZ, h.maxZ); }
  xs.sort((a, c) => a - c); zs.sort((a, c) => a - c);
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const ax = xs[i], bx = xs[i + 1], az = zs[j], bz = zs[j + 1];
      if (bx - ax < 1e-3 || bz - az < 1e-3) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (holes.some((h) => mx > h.minX && mx < h.maxX && mz > h.minZ && mz < h.maxZ)) continue;
      b.boxMM(ax, y, az, bx, y + thick, bz, color, { bottom: true });
    }
  }
}

/** Ring wall for disc areas: N segments with gaps where corridors enter. fn(b, x, z, yaw, segW, i) builds each segment. */
export function ringSegments(area, n, gapHalfAngle, fn) {
  const { cx, cz, rWall } = area.disc;
  const seg = (Math.PI * 2) / n;
  const segW = 2 * rWall * Math.tan(seg / 2);
  const openings = [];
  if (area.corridorIn) openings.push(Math.atan2(area.corridorIn.x - cx, area.corridorIn.zB - cz));
  if (area.corridorOut) openings.push(Math.atan2(area.corridorOut.x - cx, area.corridorOut.zA - cz));
  for (let i = 0; i < n; i++) {
    const a = i * seg + seg / 2;
    let blocked = false;
    for (const o of openings) {
      let d = Math.abs(((a - o + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < gapHalfAngle + seg / 2 - 0.02) blocked = true;
    }
    if (blocked) continue;
    const x = cx + Math.sin(a) * rWall, z = cz + Math.cos(a) * rWall;
    fn(x, z, a, segW, i);
  }
}
