// Generic low-poly props + a local-frame helper for building rotated, multi-part props.
import { MeshBuilder, cylGeo, lin, mix } from './geo.js';

/** Local frame at (x, z) rotated by yaw: local +Z = forward (sin yaw, cos yaw). */
export class Local {
  constructor(x = 0, z = 0, yaw = 0) { this.set(x, z, yaw); }
  set(x, z, yaw) { this.x = x; this.z = z; this.yaw = yaw; this.c = Math.cos(yaw); this.s = Math.sin(yaw); return this; }
  px(lx, lz) { return this.x + lx * this.c + lz * this.s; }
  pz(lx, lz) { return this.z - lx * this.s + lz * this.c; }
  box(b, lx, y0, lz, sx, sy, sz, color, opts = null, ry = 0) { b.box(this.px(lx, lz), y0, this.pz(lx, lz), sx, sy, sz, color, this.yaw + ry, opts); return this; }
  /** Disc / short cylinder whose axis points along local +Z (doors, dials, clocks). */
  disc(b, lx, y, lz, r, depth, color, seg = 12) {
    b.geom(cylGeo(seg), MeshBuilder.mat(this.px(lx, lz), y, this.pz(lx, lz), Math.PI / 2, this.yaw, 0, r, depth, r), color);
    return this;
  }
  cyl(b, lx, y0, lz, r, h, color, opts = {}) { b.cyl(this.px(lx, lz), y0, this.pz(lx, lz), r, h, color, opts); return this; }
  blob(b, lx, y, lz, rx, ry, rz, color, detail = 0) { b.blob(this.px(lx, lz), y, this.pz(lx, lz), rx, ry, rz, color, detail, this.yaw); return this; }
  bar(b, lx0, y0, lz0, lx1, y1, lz1, r, color, seg = 6) { b.bar(this.px(lx0, lz0), y0, this.pz(lx0, lz0), this.px(lx1, lz1), y1, this.pz(lx1, lz1), r, color, seg); return this; }
}

const L = new Local();

/** Potted plant: pot + faceted foliage. */
export function plant(b, x, z, s = 1, pot = 0xd9cbb4, leaf = 0x5f9a6a, rng = Math.random) {
  b.cyl(x, 0, z, 0.2 * s, 0.38 * s, pot, { rTop: 0.24 * s, seg: 8 });
  b.cyl(x, 0.36 * s, z, 0.22 * s, 0.03, 0x5a4636, { seg: 8 });
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 0.12 * s;
    b.blob(x + Math.cos(a) * r, (0.55 + rng() * 0.45) * s, z + Math.sin(a) * r, (0.2 + rng() * 0.1) * s, (0.28 + rng() * 0.15) * s, (0.2 + rng() * 0.1) * s,
      mix(leaf, 0x2f5a3a, rng() * 0.35), 0, rng() * 3);
  }
}

/** Wooden crate with slat lines. */
export function crate(b, x, y, z, s, color, yaw = 0) {
  b.box(x, y, z, s, s * 0.8, s, color, yaw);
  const dark = mix(color, 0x000000, 0.25);
  L.set(x, z, yaw);
  for (const sz of [-1, 1]) {
    L.box(b, 0, y + s * 0.05, sz * (s / 2 + 0.005), s * 1.0, s * 0.08, 0.02, dark);
    L.box(b, 0, y + s * 0.67, sz * (s / 2 + 0.005), s * 1.0, s * 0.08, 0.02, dark);
  }
}

/** Simple stool. */
export function stool(b, x, z, seat = 0xe0553f, leg = 0xb9c0c4, h = 0.62) {
  b.cyl(x, h - 0.05, z, 0.18, 0.06, seat, { seg: 10 });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.6;
    b.bar(x + Math.cos(a) * 0.13, 0, z + Math.sin(a) * 0.13, x + Math.cos(a) * 0.08, h - 0.05, z + Math.sin(a) * 0.08, 0.016, leg, 4);
  }
  b.cyl(x, 0.25, z, 0.11, 0.02, leg, { seg: 8 });
}

/** Bag / sack (faceted lump). */
export function sack(b, x, z, s, color, rng = Math.random) {
  b.blob(x, 0.22 * s, z, 0.3 * s, 0.25 * s, 0.26 * s, color, 0, rng() * 3);
  b.blob(x + 0.05, 0.42 * s, z - 0.02, 0.1 * s, 0.08 * s, 0.1 * s, mix(color, 0x000000, 0.15), 0);
}

/** Leafy tree: trunk + clustered canopy. leaves: hex colour or array of hex colours. */
export function tree(b, x, z, s, trunk, leaves, rng = Math.random, opts = {}) {
  const pick = () => (Array.isArray(leaves) ? leaves[Math.floor(rng() * leaves.length)] : leaves);
  const h = (opts.h ?? 2.6) * s;
  b.cyl(x, 0, z, 0.1 * s, h, trunk, { rTop: 0.06 * s, seg: 6 });
  const n = opts.clusters ?? 5;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, r = (0.3 + rng() * 0.5) * s;
    const cy = h + (rng() * 0.6 - 0.1) * s;
    b.blob(x + Math.cos(a) * r, cy, z + Math.sin(a) * r, (0.55 + rng() * 0.35) * s, (0.45 + rng() * 0.25) * s, (0.55 + rng() * 0.35) * s, pick(), 0, rng() * 3);
  }
  b.blob(x, h + 0.35 * s, z, 0.75 * s, 0.6 * s, 0.75 * s, pick(), 0, rng() * 3);
}

/** Lantern (paper, emissive): body + caps. Returns the light position. */
export function lantern(b, x, y, z, r, color, glowK = 1.6) {
  const g = b.glowK;
  b.glow(glowK);
  b.cyl(x, y - r * 0.9, z, r, r * 1.8, color, { seg: 8, rTop: r * 0.92 });
  b.glow(g);
  b.cyl(x, y + r * 0.85, z, r * 0.55, r * 0.22, 0x2a1d18, { seg: 6 });
  b.cyl(x, y - r * 1.05, z, r * 0.5, r * 0.2, 0x2a1d18, { seg: 6 });
  return { x, y, z };
}

/** Catenary string between two points with n hanging lanterns. Pushes bake lights into `lights`. */
export function lanternString(b, a, c, n, sag, colors, lights, opts = {}) {
  const segs = 10;
  let px = a[0], py = a[1], pz = a[2];
  const at = (t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t - Math.sin(Math.PI * t) * sag, a[2] + (c[2] - a[2]) * t];
  for (let i = 1; i <= segs; i++) {
    const p = at(i / segs);
    b.beam(px, py, pz, p[0], p[1], p[2], 0.025, 0.025, 0x2b2522);
    px = p[0]; py = p[1]; pz = p[2];
  }
  const r = opts.r ?? 0.16;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const p = at(t);
    const col = colors[i % colors.length];
    lantern(b, p[0], p[1] - 0.12 - r, p[2], r, col, opts.glow ?? 1.2);
    b.beam(p[0], p[1], p[2], p[0], p[1] - 0.12, p[2], 0.015, 0.015, 0x2b2522);
    if (lights && (opts.every ? i % opts.every === 0 : true)) {
      lights.push({ x: p[0], y: p[1] - 0.3, z: p[2], color: lin(opts.lightColor ?? col), intensity: opts.intensity ?? 0.9, range: opts.range ?? 4.5 });
    }
  }
}

export { L as _L };
