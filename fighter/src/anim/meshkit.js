// Tiny low-poly geometry builder for rigid-skinned fighters. Every part is authored in its bone's LOCAL space
// (bones are at rest = identity rotation, so local axes are the fighter axes: +X own left, +Y up, +Z forward).
// Triangles carry a colour, a bone index and a material group (0 = cloth/body, 1 = mask/trim gloss).
// Load-time only.
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/** Hex / Color -> THREE.Color (linear, colour-managed). */
export const col = (c) => (c && c.isColor ? c.clone() : new THREE.Color(c));
/** Brightness-scaled copy of a colour. */
export const shade = (c, k) => col(c).multiplyScalar(k);
/** Mix two colours. */
export const mix = (a, b, t) => col(a).lerp(col(b), t);

export class MeshKit {
  constructor() { this.P = []; this.C = []; this.B = []; this.G = []; this.bone = 0; this.group = 0; this.m = null; }
  /** Select the bone and material group subsequent triangles belong to; clears the transform. */
  at(bone, group = 0) { this.bone = bone; this.group = group; this.m = null; return this; }
  /** Optional transform (Matrix4) applied to subsequent points, or null. */
  xf(m) { this.m = m; return this; }
  _push(p, c) {
    if (this.m) { _v.set(p[0], p[1], p[2]).applyMatrix4(this.m); this.P.push(_v.x, _v.y, _v.z); } else this.P.push(p[0], p[1], p[2]);
    this.C.push(c.r, c.g, c.b); this.B.push(this.bone); this.G.push(this.group);
  }
  tri(a, b, c, color) { const k = col(color); this._push(a, k); this._push(b, k); this._push(c, k); return this; }
  quad(a, b, c, d, color) { this.tri(a, b, c, color); this.tri(a, c, d, color); return this; }

  /** Ring of n points: ellipse (rx, rz) at height y centred on (cx, cz), starting angle rot (radians). */
  static ring(n, y, rx, rz, cx = 0, cz = 0, rot = 0) {
    const out = [];
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz]); }
    return out;
  }

  /**
   * Loft rings (same point count) bottom -> top. colors: one colour or an array (one per band).
   * caps: { bottom: color|false, top: color|false }.
   */
  loft(rings, colors, caps = {}) {
    const n = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      const c = Array.isArray(colors) ? colors[Math.min(r, colors.length - 1)] : colors;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        this.tri(A[i], B[i], A[j], c);
        this.tri(A[j], B[i], B[j], c);
      }
    }
    const cen = (R) => R.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n, s[2] + p[2] / n], [0, 0, 0]);
    if (caps.bottom) { const R = rings[0], C = cen(R); for (let i = 0; i < n; i++) this.tri(C, R[i], R[(i + 1) % n], caps.bottom); }
    if (caps.top) { const R = rings[rings.length - 1], C = cen(R); for (let i = 0; i < n; i++) this.tri(C, R[(i + 1) % n], R[i], caps.top); }
    return this;
  }

  /**
   * Tapered tube along Y through sections [y, rx, rz, cx?, cz?]. Colours per band; capped both ends by default.
   */
  tube(n, sections, colors, caps = true, rot = Math.PI / n) {
    const rings = sections.map((s) => MeshKit.ring(n, s[0], s[1], s[2], s[3] || 0, s[4] || 0, rot));
    const first = Array.isArray(colors) ? colors[0] : colors, last = Array.isArray(colors) ? colors[colors.length - 1] : colors;
    return this.loft(rings, colors, caps ? { bottom: caps === 'top' ? false : first, top: caps === 'bottom' ? false : last } : {});
  }

  /** Box centred at c with size s; taper scales the top face (x, z). Optional per-face colours {top, bottom}. */
  box(c, s, color, taper = 1, faces = {}) {
    const [x, y, z] = c, hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    const tx = hx * (Array.isArray(taper) ? taper[0] : taper), tz = hz * (Array.isArray(taper) ? taper[1] : taper);
    const b = [[x - hx, y - hy, z - hz], [x + hx, y - hy, z - hz], [x + hx, y - hy, z + hz], [x - hx, y - hy, z + hz]];
    const t = [[x - tx, y + hy, z - tz], [x + tx, y + hy, z - tz], [x + tx, y + hy, z + tz], [x - tx, y + hy, z + tz]];
    return this.loft([b, t], color, { bottom: faces.bottom || color, top: faces.top || color });
  }

  /** Thin slab from p0 to p1 (a strap / lapel / tail): width along `side`, thickness along `normal`. */
  strip(p0, p1, width, thick, normal, color, width1 = width) {
    const a = new THREE.Vector3().fromArray(p0), b = new THREE.Vector3().fromArray(p1);
    const d = b.clone().sub(a).normalize();
    const nrm = new THREE.Vector3().fromArray(normal).normalize();
    const side = new THREE.Vector3().crossVectors(d, nrm).normalize();
    const n2 = new THREE.Vector3().crossVectors(side, d).normalize().multiplyScalar(thick / 2);
    const P = (base, w, sgn, s2) => base.clone().addScaledVector(side, (w / 2) * sgn).addScaledVector(n2, s2).toArray();
    const r0 = [P(a, width, -1, -1), P(a, width, 1, -1), P(a, width, 1, 1), P(a, width, -1, 1)];
    const r1 = [P(b, width1, -1, -1), P(b, width1, 1, -1), P(b, width1, 1, 1), P(b, width1, -1, 1)];
    // ring order must wind around the axis d; loft caps both ends
    return this.loft([r0, r1], color, { bottom: color, top: color });
  }

  /**
   * Ribbon following a surface: points [[x,y,z]...] with outward normals [[nx,ny,nz]...]; constant width,
   * thickness extruded outward. Closed (top, sides, ends) so it works with front-face culling.
   */
  ribbon(points, normals, width, thick, color, width1 = width) {
    const n = points.length;
    const L = [], R = [], Lo = [], Ro = [];
    for (let i = 0; i < n; i++) {
      const p = new THREE.Vector3().fromArray(points[i]);
      const nr = new THREE.Vector3().fromArray(normals[i]).normalize();
      const a = new THREE.Vector3().fromArray(points[Math.max(0, i - 1)]), b = new THREE.Vector3().fromArray(points[Math.min(n - 1, i + 1)]);
      const d = b.sub(a).normalize();
      const side = new THREE.Vector3().crossVectors(d, nr).normalize();
      const w = (width + (width1 - width) * (i / Math.max(1, n - 1))) / 2;
      L.push(p.clone().addScaledVector(side, -w).toArray()); R.push(p.clone().addScaledVector(side, w).toArray());
      Lo.push(p.clone().addScaledVector(side, -w).addScaledVector(nr, thick).toArray()); Ro.push(p.clone().addScaledVector(side, w).addScaledVector(nr, thick).toArray());
    }
    for (let i = 0; i < n - 1; i++) {
      this.quad(Lo[i], Ro[i], Ro[i + 1], Lo[i + 1], color);   // outer face
      this.quad(L[i], Lo[i], Lo[i + 1], L[i + 1], color);     // edges
      this.quad(Ro[i], R[i], R[i + 1], Ro[i + 1], color);
    }
    this.quad(L[0], R[0], Ro[0], Lo[0], color);
    this.quad(R[n - 1], L[n - 1], Lo[n - 1], Ro[n - 1], color);
    return this;
  }

  /** Low-poly ellipsoid. colorFn(nx, ny, nz) -> colour per face (n = face centre direction). */
  ellipsoid(c, r, seg, rings, colorFn, opts = {}) {
    const vMin = opts.vMin ?? -Math.PI / 2, vMax = opts.vMax ?? Math.PI / 2;
    const pt = (i, j) => {
      const u = (i / seg) * Math.PI * 2 + (opts.rot || 0), v = vMin + (j / rings) * (vMax - vMin);
      return [c[0] + Math.sin(u) * Math.cos(v) * r[0], c[1] + Math.sin(v) * r[1], c[2] + Math.cos(u) * Math.cos(v) * r[2]];
    };
    const cf = typeof colorFn === 'function' ? colorFn : () => colorFn;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = pt(i, j), b = pt(i + 1, j), cc = pt(i + 1, j + 1), d = pt(i, j + 1);
        const u = ((i + 0.5) / seg) * Math.PI * 2 + (opts.rot || 0), v = vMin + ((j + 0.5) / rings) * (vMax - vMin);
        const color = cf(Math.sin(u) * Math.cos(v), Math.sin(v), Math.cos(u) * Math.cos(v));
        // outward winding for this parameterisation: (a, b, d) / (b, c, d)
        if (j > 0 || vMin > -Math.PI / 2 + 1e-3) this.tri(a, b, d, color);
        if (j < rings - 1 || vMax < Math.PI / 2 - 1e-3) this.tri(b, cc, d, color);
      }
    }
    return this;
  }

  /**
   * Shell over an ellipsoid patch (masks, hoods). us / vs: column / row angles in DEGREES (u: yaw from +Z toward +X,
   * v: pitch up). push(u, v) -> extra radial offset in metres. colorFn(i, j, u, v) -> colour of cell (i, j).
   * inner: colour for a reversed inner layer (makes the shell solid from behind), or null.
   */
  shell(c, r, us, vs, push, colorFn, inner = null, innerScale = 0.97) {
    const P = (u, v, k) => {
      const ur = u * Math.PI / 180, vr = v * Math.PI / 180, e = 1 + (push ? push(u, v) : 0) / r[2];
      return [c[0] + Math.sin(ur) * Math.cos(vr) * r[0] * e * k, c[1] + Math.sin(vr) * r[1] * e * k, c[2] + Math.cos(ur) * Math.cos(vr) * r[2] * e * k];
    };
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < us.length - 1; i++) {
        const a = P(us[i], vs[j], 1), b = P(us[i + 1], vs[j], 1), cc = P(us[i + 1], vs[j + 1], 1), d = P(us[i], vs[j + 1], 1);
        const color = colorFn(i, j, (us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2);
        if (!color) continue;
        this.tri(a, b, cc, color); this.tri(a, cc, d, color);
        if (inner) {
          const a2 = P(us[i], vs[j], innerScale), b2 = P(us[i + 1], vs[j], innerScale), c2 = P(us[i + 1], vs[j + 1], innerScale), d2 = P(us[i], vs[j + 1], innerScale);
          this.tri(a2, c2, b2, inner); this.tri(a2, d2, c2, inner);
        }
      }
    }
    return this;
  }

  /** Build a BufferGeometry (non-indexed, flat) with skinIndex / skinWeight and 2 material groups. */
  build() {
    const tris = this.P.length / 9;
    const order = [];
    for (let g = 0; g < 2; g++) for (let t = 0; t < tris; t++) if (this.G[t * 3] === g) order.push(t);
    const pos = new Float32Array(tris * 9), colr = new Float32Array(tris * 9);
    const si = new Uint16Array(tris * 12), sw = new Float32Array(tris * 12);
    let n0 = 0;
    order.forEach((t, k) => {
      if (this.G[t * 3] === 0) n0++;
      for (let v = 0; v < 3; v++) {
        const src = t * 3 + v, dst = k * 3 + v;
        pos[dst * 3] = this.P[src * 3]; pos[dst * 3 + 1] = this.P[src * 3 + 1]; pos[dst * 3 + 2] = this.P[src * 3 + 2];
        colr[dst * 3] = this.C[src * 3]; colr[dst * 3 + 1] = this.C[src * 3 + 1]; colr[dst * 3 + 2] = this.C[src * 3 + 2];
        si[dst * 4] = this.B[src]; sw[dst * 4] = 1;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    g.computeVertexNormals();
    g.addGroup(0, n0 * 3, 0);
    g.addGroup(n0 * 3, (tris - n0) * 3, 1);
    return g;
  }
}

export { _c as _scratchColor };
