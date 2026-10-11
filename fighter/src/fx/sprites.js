// SpriteField: every short-lived FX particle (impact flashes, rings, shards, sparks, puffs) in ONE dynamic mesh =
// one draw call. Struct-of-arrays storage, swap-remove, quads rebuilt in world space each frame for live particles
// only. Zero allocations per frame. spawn() takes a reusable params object (see SPRITE) and copies it in.
import * as THREE from 'three';
import { makeFxMaterial, markRange } from './material.js';

export const SHAPE = { SOFT: 0, RING: 1, SHARD: 2, FLASH: 3 };
/** CAMERA: billboard (optional spin). PLANE: quad in the plane whose normal is (nx, ny, nz). STREAK: stretched along velocity. */
export const ORIENT = { CAMERA: 0, PLANE: 1, STREAK: 2 };

/** Reusable spawn parameters. Call resetSprite(P) and fill the fields you need. */
export function resetSprite(p) {
  p.x = p.y = p.z = 0; p.vx = p.vy = p.vz = 0; p.nx = 0; p.ny = 1; p.nz = 0;
  p.life = 0.1; p.delay = 0; p.size0 = 0.1; p.size1 = 0.1; p.width = 0.02;
  p.r = 1; p.g = 1; p.b = 1; p.alpha = 1; p.shape = SHAPE.SOFT; p.orient = ORIENT.CAMERA;
  p.add = 1; p.drag = 0; p.grav = 0; p.spin = 0; p.pull = 0; p.fadePow = 1; p.fadeIn = 0; p.core = 0; p.grow = 2;
  return p;
}
export const SPRITE = resetSprite({});

const _f32 = (n) => new Float32Array(n);

export class SpriteField {
  constructor(max = 256) {
    this.max = max;
    this.count = 0;
    this.spawned = 0;
    this.pos = _f32(max * 3); this.vel = _f32(max * 3); this.nrm = _f32(max * 3); this.col = _f32(max * 3);
    this.age = _f32(max); this.life = _f32(max); this.delay = _f32(max);
    this.size0 = _f32(max); this.size1 = _f32(max); this.width = _f32(max);
    this.alpha = _f32(max); this.add = _f32(max); this.drag = _f32(max); this.grav = _f32(max);
    this.spin = _f32(max); this.pull = _f32(max); this.fadePow = _f32(max); this.fadeIn = _f32(max);
    this.core = _f32(max); this.grow = _f32(max);
    this.shape = new Uint8Array(max); this.orient = new Uint8Array(max);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 16), 4).setUsage(THREE.DynamicDrawUsage);
    this.aShp = new THREE.BufferAttribute(new Float32Array(max * 16), 4).setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(max * 8);
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      uv.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    g.setAttribute('position', this.aPos);
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aShape', this.aShp);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, makeFxMaterial());
    this.mesh.name = 'fx-sprites';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 30;
    this.mesh.visible = false;
  }

  /** Copy a params object into a free slot (steals the oldest when full). Returns the slot index. */
  spawn(p) {
    let i = this.count;
    if (i >= this.max) {
      // steal the most advanced particle
      let best = 0, bu = -1;
      for (let k = 0; k < this.count; k++) { const u = (this.age[k] - this.delay[k]) / this.life[k]; if (u > bu) { bu = u; best = k; } }
      i = best;
    } else this.count++;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx; this.vel[i3 + 1] = p.vy; this.vel[i3 + 2] = p.vz;
    this.nrm[i3] = p.nx; this.nrm[i3 + 1] = p.ny; this.nrm[i3 + 2] = p.nz;
    this.col[i3] = p.r; this.col[i3 + 1] = p.g; this.col[i3 + 2] = p.b;
    this.age[i] = 0; this.life[i] = Math.max(0.005, p.life); this.delay[i] = Math.max(0, p.delay);
    this.size0[i] = p.size0; this.size1[i] = p.size1; this.width[i] = p.width;
    this.alpha[i] = p.alpha; this.add[i] = p.add; this.drag[i] = p.drag; this.grav[i] = p.grav;
    this.spin[i] = p.spin; this.pull[i] = p.pull; this.fadePow[i] = p.fadePow; this.fadeIn[i] = p.fadeIn;
    this.core[i] = p.core; this.grow[i] = p.grow;
    this.shape[i] = p.shape; this.orient[i] = p.orient;
    this.spawned++;
    return i;
  }

  clear() { this.count = 0; this.geometry.setDrawRange(0, 0); this.mesh.visible = false; }

  _move(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k];
      this.nrm[t3 + k] = this.nrm[f3 + k]; this.col[t3 + k] = this.col[f3 + k];
    }
    this.age[to] = this.age[from]; this.life[to] = this.life[from]; this.delay[to] = this.delay[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from]; this.width[to] = this.width[from];
    this.alpha[to] = this.alpha[from]; this.add[to] = this.add[from]; this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from]; this.spin[to] = this.spin[from]; this.pull[to] = this.pull[from];
    this.fadePow[to] = this.fadePow[from]; this.fadeIn[to] = this.fadeIn[from]; this.core[to] = this.core[from];
    this.grow[to] = this.grow[from]; this.shape[to] = this.shape[from]; this.orient[to] = this.orient[from];
  }

  /** Advance (dt seconds) and rebuild the quads facing `camera`. */
  update(dt, camera) {
    // 1. age + physics, swap-remove the dead
    let n = this.count;
    for (let i = 0; i < n;) {
      const a = (this.age[i] += dt);
      if (a >= this.life[i] + this.delay[i]) { n--; if (i !== n) this._move(n, i); continue; }
      if (a > this.delay[i]) {
        const i3 = i * 3;
        const dr = this.drag[i];
        if (dr > 0) { const k = Math.exp(-dr * dt); this.vel[i3] *= k; this.vel[i3 + 1] *= k; this.vel[i3 + 2] *= k; }
        this.vel[i3 + 1] -= this.grav[i] * dt;
        this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      }
      i++;
    }
    this.count = n;
    if (n === 0) { if (this.mesh.visible) { this.geometry.setDrawRange(0, 0); this.mesh.visible = false; } return; }
    this.mesh.visible = true;

    // 2. camera basis
    const e = camera.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2], ux = e[4], uy = e[5], uz = e[6], cx = e[12], cy = e[13], cz = e[14];
    const P = this.aPos.array, C = this.aCol.array, S = this.aShp.array;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let px = this.pos[i3], py = this.pos[i3 + 1], pz = this.pos[i3 + 2];
      const u = Math.max(0, (this.age[i] - this.delay[i]) / this.life[i]);
      const visible = this.age[i] >= this.delay[i];
      const g = this.grow[i];
      const s = this.size0[i] + (this.size1[i] - this.size0[i]) * (1 - Math.pow(1 - Math.min(1, u), g));
      let al = visible ? this.alpha[i] * Math.pow(Math.max(0, 1 - u), this.fadePow[i]) : 0;
      const fi = this.fadeIn[i];
      if (fi > 0 && u < fi) al *= u / fi;
      // pull toward the camera so flashes on a body surface are not swallowed by it
      let tx = cx - px, ty = cy - py, tz = cz - pz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const pl = this.pull[i];
      if (pl) { px += tx * pl; py += ty * pl; pz += tz * pl; }
      let ax, ay, az, bx, by, bz;   // half-extent axes of the quad (x: uv.x, y: uv.y)
      const o = this.orient[i];
      if (o === ORIENT.STREAK) {
        let vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
        let vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vl < 1e-4) { vx = this.nrm[i3]; vy = this.nrm[i3 + 1]; vz = this.nrm[i3 + 2]; vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1; }
        vx /= vl; vy /= vl; vz /= vl;
        // side = axis x toCam
        let sx = vy * tz - vz * ty, sy = vz * tx - vx * tz, sz = vx * ty - vy * tx;
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        const w = this.width[i] * (0.4 + 0.6 * (1 - u));
        sx *= w / sl; sy *= w / sl; sz *= w / sl;
        const len = s;
        ax = sx; ay = sy; az = sz;
        bx = vx * len; by = vy * len; bz = vz * len;
        // the head leads: offset the diamond back along its axis so it trails behind the moving point
        px -= bx * 0.5; py -= by * 0.5; pz -= bz * 0.5;
      } else if (o === ORIENT.PLANE) {
        const nx = this.nrm[i3], ny = this.nrm[i3 + 1], nz = this.nrm[i3 + 2];
        // t1 = normalize(helper x n), t2 = n x t1
        let hx = 0, hy = 1, hz = 0;
        if (Math.abs(ny) > 0.9) { hx = 1; hy = 0; }
        let t1x = hy * nz - hz * ny, t1y = hz * nx - hx * nz, t1z = hx * ny - hy * nx;
        const t1l = Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z) || 1;
        t1x /= t1l; t1y /= t1l; t1z /= t1l;
        const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
        ax = t1x * s; ay = t1y * s; az = t1z * s;
        bx = t2x * s; by = t2y * s; bz = t2z * s;
      } else {
        const sp = this.spin[i];
        if (sp) {
          const c = Math.cos(sp), sn = Math.sin(sp);
          ax = (rx * c + ux * sn) * s; ay = (ry * c + uy * sn) * s; az = (rz * c + uz * sn) * s;
          bx = (ux * c - rx * sn) * s; by = (uy * c - ry * sn) * s; bz = (uz * c - rz * sn) * s;
        } else {
          ax = rx * s; ay = ry * s; az = rz * s;
          bx = ux * s; by = uy * s; bz = uz * s;
        }
      }
      const v = i * 12;
      P[v] = px - ax - bx; P[v + 1] = py - ay - by; P[v + 2] = pz - az - bz;
      P[v + 3] = px + ax - bx; P[v + 4] = py + ay - by; P[v + 5] = pz + az - bz;
      P[v + 6] = px + ax + bx; P[v + 7] = py + ay + by; P[v + 8] = pz + az + bz;
      P[v + 9] = px - ax + bx; P[v + 10] = py - ay + by; P[v + 11] = pz - az + bz;
      const sh = this.shape[i];
      let shy = this.core[i];
      if (sh === SHAPE.RING) shy = Math.max(0, 1 - this.width[i] / Math.max(1e-4, s));
      const r = this.col[i3], gg = this.col[i3 + 1], b = this.col[i3 + 2], ad = this.add[i];
      for (let k = 0; k < 4; k++) {
        const c4 = i * 16 + k * 4;
        C[c4] = r; C[c4 + 1] = gg; C[c4 + 2] = b; C[c4 + 3] = al;
        S[c4] = sh; S[c4 + 1] = shy; S[c4 + 2] = ad; S[c4 + 3] = 0;
      }
    }
    markRange(this.aPos, n * 12);
    markRange(this.aCol, n * 16);
    markRange(this.aShp, n * 16);
    this.geometry.setDrawRange(0, n * 6);
  }
}
