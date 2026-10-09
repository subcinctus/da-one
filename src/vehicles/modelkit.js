// Low-level voxel model kit for vehicles: a part collector (boxes, tapers, lofts, mirrored pairs) that bakes
// into non-indexed BufferGeometry with flat normals + baked per-face shading in vertex colours.
// Pure THREE (no DOM): importable from Node.
import * as THREE from 'three';

const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();

// 6 faces x 2 triangles, CCW seen from outside (see corner order in hexa()).
const FACES = [
  0, 1, 2, 0, 2, 3, // bottom (-y)
  4, 6, 5, 4, 7, 6, // top (+y)
  3, 2, 6, 3, 6, 7, // front (+z)
  1, 0, 4, 1, 4, 5, // back (-z)
  2, 1, 5, 2, 5, 6, // +x
  0, 3, 7, 0, 7, 4, // -x
];

/**
 * Collects parts into three layers: 'b' (opaque body, vertex colours), 'g' (glass), 'l' (lights, with a role).
 * Corner order of a hexahedron: bottom quad 0..3 = (x0,z0) (x1,z0) (x1,z1) (x0,z1), top quad 4..7 likewise.
 */
export class Spec {
  constructor() {
    this.b = []; this.g = []; this.l = [];
    this.meta = {};
  }

  /** Raw 8-corner part. c = Float32Array/array of 24 numbers. */
  hexa(layer, c, col, role) {
    this[layer].push({ c: Float32Array.from(c), col, role: role || null });
    return this;
  }

  /** Axis-aligned box. */
  box(layer, x0, y0, z0, x1, y1, z1, col, role) {
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (y0 > y1) [y0, y1] = [y1, y0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    return this.hexa(layer, [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1], col, role);
  }

  /** Box mirrored on both sides of x = 0 (give the +x half: 0 <= x0 < x1). */
  pair(layer, x0, y0, z0, x1, y1, z1, col, role, role2) {
    this.box(layer, x0, y0, z0, x1, y1, z1, col, role);
    return this.box(layer, -x1, y0, z0, -x0, y1, z1, col, role2 || role);
  }

  /** Vertical taper: bottom rect at y0, top rect at y1 (rects = [x0, x1, z0, z1]). */
  taper(layer, b, y0, t, y1, col, role) {
    return this.hexa(layer, [
      b[0], y0, b[2], b[1], y0, b[2], b[1], y0, b[3], b[0], y0, b[3],
      t[0], y1, t[2], t[1], y1, t[2], t[1], y1, t[3], t[0], y1, t[3],
    ], col, role);
  }

  /** Loft along z: cross-section a = [x0, x1, y0, y1] at z0 to cross-section b at z1 (z0 < z1). */
  loft(layer, z0, a, z1, b, col, role) {
    return this.hexa(layer, [
      a[0], a[2], z0, a[1], a[2], z0, b[1], b[2], z1, b[0], b[2], z1,
      a[0], a[3], z0, a[1], a[3], z0, b[1], b[3], z1, b[0], b[3], z1,
    ], col, role);
  }

  /** Mirror an arbitrary 8-corner part across x = 0 (keeps the winding valid). */
  mirrorHexa(layer, c, col, role) {
    const m = Array.from(c);
    for (let i = 0; i < 8; i++) m[i * 3] = -m[i * 3];
    // swap 0<->1, 2<->3, 4<->5, 6<->7 so x stays ordered low->high per edge
    const swap = (i, j) => { for (let k = 0; k < 3; k++) { const t = m[i * 3 + k]; m[i * 3 + k] = m[j * 3 + k]; m[j * 3 + k] = t; } };
    swap(0, 1); swap(2, 3); swap(4, 5); swap(6, 7);
    return this.hexa(layer, m, col, role);
  }

  /** Vertical taper on both sides (b/t rects given for the +x half). */
  taperPair(layer, b, y0, t, y1, col, role, role2) {
    this.taper(layer, b, y0, t, y1, col, role);
    const last = this[layer][this[layer].length - 1];
    return this.mirrorHexa(layer, last.c, col, role2 || role);
  }

  /** Loft on both sides (cross-sections given for the +x half). */
  loftPair(layer, z0, a, z1, b, col, role, role2) {
    this.loft(layer, z0, a, z1, b, col, role);
    const last = this[layer][this[layer].length - 1];
    return this.mirrorHexa(layer, last.c, col, role2 || role);
  }
}

/** Shade factor from a face normal (baked lighting for a crisp voxel read). */
function shadeOf(nx, ny, nz) {
  let s = ny >= 0 ? 0.9 + 0.1 * ny : 0.9 + 0.32 * ny;
  s -= 0.05 * Math.abs(nx);
  return s;
}

/** Cheap deterministic hash in [0,1). */
function hashf(i, seed) {
  let h = Math.imul(i + 1, 374761393) ^ Math.imul(seed + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Bake a part list into a BufferGeometry (non-indexed, flat normals, vertex colours).
 * resolve(col, partIndex) -> 0xRRGGBB. opts: {roles: Map role->index (adds userData.roles Uint8Array), jitter, seed}
 */
export function bake(parts, resolve, opts = {}) {
  const tri = FACES.length / 3;
  const nv = parts.length * tri * 3;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const roles = opts.roles ? new Uint8Array(nv) : null;
  const jitter = opts.jitter || 0;
  let v = 0;
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const c = part.c;
    _c.set(resolve(part.col, p));
    const jr = jitter ? 1 - jitter + 2 * jitter * hashf(p, opts.seed || 0) : 1;
    const ri = roles ? (opts.roles.get(part.role) ?? 0) : 0;
    for (let f = 0; f < FACES.length; f += 3) {
      const i0 = FACES[f] * 3, i1 = FACES[f + 1] * 3, i2 = FACES[f + 2] * 3;
      _a.set(c[i1] - c[i0], c[i1 + 1] - c[i0 + 1], c[i1 + 2] - c[i0 + 2]);
      _b.set(c[i2] - c[i0], c[i2 + 1] - c[i0 + 1], c[i2 + 2] - c[i0 + 2]);
      _n.crossVectors(_a, _b);
      const len = _n.length();
      if (len < 1e-9) continue; // degenerate (tapered to an edge)
      _n.divideScalar(len);
      const s = shadeOf(_n.x, _n.y, _n.z) * jr;
      const r = Math.min(1, _c.r * s), g = Math.min(1, _c.g * s), b = Math.min(1, _c.b * s);
      for (const ii of [i0, i1, i2]) {
        pos[v * 3] = c[ii]; pos[v * 3 + 1] = c[ii + 1]; pos[v * 3 + 2] = c[ii + 2];
        nor[v * 3] = _n.x; nor[v * 3 + 1] = _n.y; nor[v * 3 + 2] = _n.z;
        col[v * 3] = r; col[v * 3 + 1] = g; col[v * 3 + 2] = b;
        if (roles) roles[v] = ri;
        v++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
  if (roles) geo.userData.roles = roles.subarray(0, v);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** Merge non-indexed geometries with position/normal/color into one. Disposes the inputs. */
export function mergeColored(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

/** A THREE primitive converted to flat-shaded non-indexed geometry with a uniform vertex colour. */
export function flatColored(geo, color, shade = true) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  _c.set(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const nr = g.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const s = shade ? shadeOf(nr[i * 3], nr[i * 3 + 1], nr[i * 3 + 2]) : 1;
    col[i * 3] = Math.min(1, _c.r * s); col[i * 3 + 1] = Math.min(1, _c.g * s); col[i * 3 + 2] = Math.min(1, _c.b * s);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Scale an sRGB hex colour's brightness. */
export function shadeHex(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/** Perceived luminance (0..1) of an sRGB hex colour. */
export function luminance(hex) {
  return (0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)) / 255;
}
