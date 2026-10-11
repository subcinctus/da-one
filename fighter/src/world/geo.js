// MeshBuilder: accumulates low-poly primitives into ONE merged BufferGeometry with vertex colours and a
// per-vertex GLOW channel (baked emissive: lantern bulbs, light panels, warm light pools). Built once per room
// at chapter load; nothing here runs per frame.
import * as THREE from 'three';

const _c = new THREE.Color();
const _hexCache = new Map();
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Hex (sRGB) -> linear [r, g, b] (cached). Arrays pass through. */
export function lin(c) {
  if (Array.isArray(c)) return c;
  if (c && c.isColor) return [c.r, c.g, c.b];
  let v = _hexCache.get(c);
  if (!v) { _c.set(c); v = [_c.r, _c.g, _c.b]; _hexCache.set(c, v); }
  return v;
}
/** Linear colour helpers. */
export const mix = (a, b, t) => { a = lin(a); b = lin(b); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
export const mul = (a, k) => { a = lin(a); return [a[0] * k, a[1] * k, a[2] * k]; };

const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// shared primitive geometries (positions/normals/index only)
const _geoCache = new Map();
function cached(key, make) { let g = _geoCache.get(key); if (!g) { g = make(); _geoCache.set(key, g); } return g; }
export function cylGeo(seg = 8, open = false) { return cached('cyl' + seg + open, () => new THREE.CylinderGeometry(1, 1, 1, seg, 1, open)); }
export function coneGeo(seg = 8) { return cached('cone' + seg, () => new THREE.CylinderGeometry(0, 1, 1, seg, 1)); }
export function icoGeo(detail = 0) { return cached('ico' + detail, () => new THREE.IcosahedronGeometry(1, detail)); }
export function sphereGeo(w = 8, h = 6) { return cached('sph' + w + 'x' + h, () => new THREE.SphereGeometry(1, w, h)); }
export function torusGeo(seg = 12, tube = 0.12) { return cached('tor' + seg + tube, () => new THREE.TorusGeometry(1, tube, 4, seg)); }

const BOX_FACES = [
  // normal, 4 corners (unit cube from -0.5..0.5), CCW seen from outside
  [[1, 0, 0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]],
  [[-1, 0, 0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]],
  [[0, 1, 0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]],
  [[0, -1, 0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]],
  [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
  [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
];

export class MeshBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.glw = []; this.idx = [];
    this.ao = null;      // { y0, y1, min }: darken vertices near the floor (fake contact AO)
    this.glowK = 0;      // self-illumination for following primitives: glow = colour * glowK
    this.skipBottom = true; // boxes resting on the floor skip their invisible bottom face
    this.lift = 0;       // bake: lifts dark albedo toward grey so baked light reads on dark stone
  }
  get vertexCount() { return this.pos.length / 3; }
  get empty() { return this.idx.length === 0; }

  /** Enable height AO for following primitives (null to disable). */
  setAO(min = 0.72, y1 = 1.2, y0 = 0) { this.ao = min === null ? null : { y0, y1, min }; return this; }
  noAO() { this.ao = null; return this; }
  glow(k = 0) { this.glowK = k; return this; }

  _vert(x, y, z, nx, ny, nz, c, shade = 1) {
    let k = shade;
    if (this.ao) k *= this.ao.min + (1 - this.ao.min) * smooth(this.ao.y0, this.ao.y1, y);
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz);
    this.col.push(c[0] * k, c[1] * k, c[2] * k);
    const g = this.glowK;
    this.glw.push(c[0] * g, c[1] * g, c[2] * g);
  }

  /**
   * Box resting on y0: centre (cx, cz), size (sx, sy, sz), colour, optional Y rotation (radians).
   * opts.top: separate top colour; opts.bottom: keep bottom face; opts.rx/rz: tilt.
   */
  box(cx, y0, cz, sx, sy, sz, color, rotY = 0, opts = null) {
    const c = lin(color);
    const top = opts && opts.top !== undefined ? lin(opts.top) : c;
    const keepBottom = (opts && opts.bottom) || y0 > 0.01 || !this.skipBottom;
    const rx = opts && opts.rx ? opts.rx : 0, rz = opts && opts.rz ? opts.rz : 0;
    if (rx || rz) {
      _e.set(rx, rotY, rz, 'YXZ'); _q.setFromEuler(_e);
      _m.compose(_p.set(cx, y0 + sy / 2, cz), _q, _s.set(sx, sy, sz));
      return this._boxM(_m, c, top, true);
    }
    const cs = Math.cos(rotY), sn = Math.sin(rotY), yc = y0 + sy / 2;
    for (let f = 0; f < 6; f++) {
      if (f === 3 && !keepBottom) continue;
      const [n, corners] = BOX_FACES[f];
      const nx = n[0] * cs + n[2] * sn, nz = -n[0] * sn + n[2] * cs;
      const base = this.pos.length / 3;
      const fc = f === 2 ? top : c;
      for (const k of corners) {
        const lx = k[0] * sx, ly = k[1] * sy, lz = k[2] * sz;
        this._vert(cx + lx * cs + lz * sn, yc + ly, cz - lx * sn + lz * cs, nx, n[1], nz, fc);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** Box by min/max corners (axis aligned). */
  boxMM(x0, y0, z0, x1, y1, z1, color, opts = null) {
    return this.box((x0 + x1) / 2, Math.min(y0, y1), (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), color, 0, opts);
  }

  _boxM(m, c, top, bottom) {
    _nm.getNormalMatrix(m);
    for (let f = 0; f < 6; f++) {
      if (f === 3 && !bottom) continue;
      const [n, corners] = BOX_FACES[f];
      _n.set(n[0], n[1], n[2]).applyMatrix3(_nm).normalize();
      const base = this.pos.length / 3;
      for (const k of corners) {
        _v.set(k[0], k[1], k[2]).applyMatrix4(m);
        this._vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, f === 2 ? top : c);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** Append a THREE geometry transformed by matrix m with a flat colour (or colour fn(x,y,z)). */
  geom(g, m, color) {
    const P = g.attributes.position, N = g.attributes.normal, I = g.index;
    const fn = typeof color === 'function' ? color : null;
    const c = fn ? null : lin(color);
    _nm.getNormalMatrix(m);
    const base = this.pos.length / 3;
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      if (N) _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize(); else _n.set(0, 1, 0);
      this._vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, fn ? lin(fn(_v.x, _v.y, _v.z)) : c);
    }
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    return this;
  }

  /** Transform helper: position, euler (radians, 'YXZ'), scale. */
  static mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
    return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  }

  /** Vertical cylinder resting on y0 (radius r, or rTop/rBot). opts: {rTop, seg, rx, rz, ry, open} */
  cyl(cx, y0, cz, r, h, color, opts = {}) {
    const seg = opts.seg || 8;
    const rTop = opts.rTop !== undefined ? opts.rTop : r;
    if (rTop !== r) {
      const g = cached('cylT' + seg + ':' + (rTop / r).toFixed(3) + (opts.open ? 'o' : ''), () => new THREE.CylinderGeometry(rTop / r, 1, 1, seg, 1, !!opts.open));
      return this.geom(g, MeshBuilder.mat(cx, y0 + h / 2, cz, opts.rx || 0, opts.ry || 0, opts.rz || 0, r, h, r), color);
    }
    if (opts.rx || opts.rz) {
      // tilted: centre at (cx, y0, cz) interpreted as the cylinder centre
      return this.geom(cylGeo(seg, !!opts.open), MeshBuilder.mat(cx, y0, cz, opts.rx || 0, opts.ry || 0, opts.rz || 0, r, h, r), color);
    }
    return this.geom(cylGeo(seg, !!opts.open), MeshBuilder.mat(cx, y0 + h / 2, cz, 0, opts.ry || 0, 0, r, h, r), color);
  }

  /** Horizontal cylinder between two points (pipes, rails, bars). */
  bar(x0, y0, z0, x1, y1, z1, r, color, seg = 6) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return this;
    _v.set(dx / len, dy / len, dz / len);
    _q.setFromUnitVectors(_n.set(0, 1, 0), _v);
    _m.compose(_p.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), _q, _s.set(r, len, r));
    return this.geom(cylGeo(seg, true), _m, color);
  }

  /** Thin box between two points (beams, strings, wires). */
  beam(x0, y0, z0, x1, y1, z1, w, h, color) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return this;
    const yaw = Math.atan2(dx, dz), pitch = -Math.atan2(dy, Math.hypot(dx, dz));
    _e.set(pitch, yaw, 0, 'YXZ'); _q.setFromEuler(_e);
    _m.compose(_p.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), _q, _s.set(w, h, len));
    return this._boxM(_m, lin(color), lin(color), true);
  }

  /** Faceted blob (icosahedron), centre (cx, cy, cz), radii (rx, ry, rz). */
  blob(cx, cy, cz, rx, ry, rz, color, detail = 0, rotY = 0) {
    return this.geom(icoGeo(detail), MeshBuilder.mat(cx, cy, cz, 0, rotY, 0, rx, ry ?? rx, rz ?? rx), color);
  }

  /** Smooth-ish sphere. */
  sphere(cx, cy, cz, r, color, w = 8, h = 6, sy = 1) {
    return this.geom(sphereGeo(w, h), MeshBuilder.mat(cx, cy, cz, 0, 0, 0, r, r * sy, r), color);
  }

  /** Up-facing quad on the floor with per-corner colours (c00 at x0,z0; c10 at x1,z0; c11; c01). */
  quad(x0, z0, x1, z1, y, c00, c10, c11, c01) {
    const base = this.pos.length / 3;
    const a = lin(c00), b = lin(c10 ?? c00), c = lin(c11 ?? c00), d = lin(c01 ?? c00);
    this._vert(x0, y, z0, 0, 1, 0, a); this._vert(x1, y, z0, 0, 1, 0, b);
    this._vert(x1, y, z1, 0, 1, 0, c); this._vert(x0, y, z1, 0, 1, 0, d);
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    return this;
  }

  /** Arbitrary flat polygon (convex, fan) from points [[x,y,z],...]; normal from the first triangle. */
  poly(pts, color, doubleSided = false) {
    const c = lin(color);
    const [a, b, d] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const base = this.pos.length / 3;
    for (const p of pts) this._vert(p[0], p[1], p[2], nx, ny, nz, c);
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
    if (doubleSided) {
      const b2 = this.pos.length / 3;
      for (const p of pts) this._vert(p[0], p[1], p[2], -nx, -ny, -nz, c);
      for (let i = 1; i < pts.length - 1; i++) this.idx.push(b2, b2 + i + 1, b2 + i);
    }
    return this;
  }

  /**
   * Floor grid over [x0,x1]x[z0,z1] in cells of `cell` metres. colorFn(ix, iz, cx, cz) -> colour per cell;
   * shadeFn(x, z) -> per-vertex multiplier (AO near walls, light pools). gap: grout width (darker lines).
   */
  floor(x0, z0, x1, z1, y, cell, colorFn, shadeFn = null) {
    const nx = Math.max(1, Math.round((x1 - x0) / cell)), nz = Math.max(1, Math.round((z1 - z0) / cell));
    const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    const ao = this.ao; this.ao = null;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const ax = x0 + ix * dx, az = z0 + iz * dz, bx = ax + dx, bz = az + dz;
        const c = lin(colorFn(ix, iz, ax + dx / 2, az + dz / 2));
        const base = this.pos.length / 3;
        const s00 = shadeFn ? shadeFn(ax, az) : 1, s10 = shadeFn ? shadeFn(bx, az) : 1;
        const s11 = shadeFn ? shadeFn(bx, bz) : 1, s01 = shadeFn ? shadeFn(ax, bz) : 1;
        this._vert(ax, y, az, 0, 1, 0, c, s00); this._vert(bx, y, az, 0, 1, 0, c, s10);
        this._vert(bx, y, bz, 0, 1, 0, c, s11); this._vert(ax, y, bz, 0, 1, 0, c, s01);
        this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
    this.ao = ao;
    return this;
  }

  /**
   * Bake point lights into the glow channel: glow += albedo * light * falloff * wrap-lambert.
   * lights: [{ x, y, z, color: [r,g,b] linear, intensity, range }]
   */
  bake(lights) {
    if (!lights || !lights.length || this.empty) return this;
    const P = this.pos, N = this.nor, C = this.col, G = this.glw;
    // bounds for quick rejection
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < P.length; i += 3) { const x = P[i], z = P[i + 2]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (z < mnz) mnz = z; if (z > mxz) mxz = z; }
    const L = lights.filter((l) => l.x > mnx - l.range && l.x < mxx + l.range && l.z > mnz - l.range && l.z < mxz + l.range);
    if (!L.length) return this;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < L.length; j++) {
        const l = L[j];
        const dx = l.x - x, dy = l.y - y, dz = l.z - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > l.range * l.range) continue;
        const d = Math.sqrt(d2) + 1e-4;
        const att = (1 - d / l.range) ** 2;
        const lam = Math.max(0, (dx * N[i] + dy * N[i + 1] + dz * N[i + 2]) / d) * 0.75 + 0.25;
        const k = l.intensity * att * lam;
        r += l.color[0] * k; g += l.color[1] * k; b += l.color[2] * k;
      }
      const lf = this.lift, base = 0.3 * lf;
      G[i] += (C[i] * (1 - lf) + base) * r; G[i + 1] += (C[i + 1] * (1 - lf) + base) * g; G[i + 2] += (C[i + 2] * (1 - lf) + base) * b;
    }
    return this;
  }

  /** Finish: a BufferGeometry (position, normal, color, glow, index). */
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(this.glw, 3));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Shared environment materials. All take vertex colours and the per-vertex `glow` attribute
 * (added to emissive radiance), so lights can be baked into geometry at load time.
 */
export function makeMaterials() {
  const addGlow = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 glow;\nvarying vec3 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
  };
  const std = (params, key) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, ...params });
    m.onBeforeCompile = addGlow;
    m.customProgramCacheKey = () => 'envglow-' + key;
    return m;
  };
  return {
    /** Matte surfaces: walls, floors, props. */
    matte: std({ roughness: 0.88 }, 'matte'),
    /** Gloss: water, polished floor, chrome, lacquer (sun highlights). */
    gloss: std({ roughness: 0.22, metalness: 0.05 }, 'gloss'),
    /** Glass / clear panels (transparent, no depth write). */
    glass: (() => {
      const m = std({ roughness: 0.1, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }, 'glass');
      // r160 draws transparent DoubleSide materials in two passes (back, then front) and flags needsUpdate before
      // each, rebuilding program parameters twice per mesh per frame. Panes are thin at alpha 0.22: one pass is fine.
      m.forceSinglePass = true;
      return m;
    })(),
  };
}
