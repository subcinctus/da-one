// FX helpers (owned by ATMOSPHERE): pooled point lights, tracer line segments, muzzle-flash sprites, bullet-hole decals.
// Everything is preallocated; per-frame updates write into typed arrays only.
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------------------------
/** A few PointLights that always live in the scene (intensity 0 when idle, so shader light counts never change). */
export class LightPool {
  constructor(scene, count = 3) {
    this.lights = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 20, 2);
      l.name = 'fxLight' + i;
      l.userData = { t: 0, dur: 1, peak: 0, prio: 0, follow: null, flicker: 0, hold: false };
      scene.add(l);
      this.lights.push(l);
    }
  }

  /**
   * Flash a light. prio: higher steals lower. hold = keep until release() (fire). follow = live Vector3.
   * Returns the light (or null when every light is busy with higher priority).
   */
  flash(x, y, z, color, intensity, distance, duration, prio = 1, hold = false, follow = null, flicker = 0) {
    let best = null, bestScore = Infinity;
    for (const l of this.lights) {
      const u = l.userData;
      const busy = u.hold || u.t > 0;
      const score = busy ? (u.prio >= prio ? Infinity : u.prio * 10 + u.t) : -1;
      if (score < bestScore) { bestScore = score; best = l; }
    }
    if (!best || bestScore === Infinity) return null;
    const u = best.userData;
    best.position.set(x, y, z);
    best.color.setHex(color);
    best.distance = distance;
    u.t = duration; u.dur = duration; u.peak = intensity; u.prio = prio; u.hold = hold; u.follow = follow; u.flicker = flicker;
    best.intensity = intensity;
    return best;
  }

  release(light) {
    if (!light) return;
    const u = light.userData;
    u.hold = false; u.follow = null;
    if (u.t <= 0) light.intensity = 0;
  }

  update(dt) {
    for (const l of this.lights) {
      const u = l.userData;
      if (u.follow) l.position.set(u.follow.x, u.follow.y + 0.8, u.follow.z);
      if (u.hold) {
        const fl = u.flicker > 0 ? 1 - u.flicker * (0.5 + 0.5 * Math.sin(performance.now() * 0.023 + l.id) * Math.sin(performance.now() * 0.017)) : 1;
        l.intensity = u.peak * fl;
        continue;
      }
      if (u.t > 0) {
        u.t -= dt;
        const k = Math.max(0, u.t / u.dur);
        l.intensity = u.peak * k * k;
        if (u.t <= 0) { l.intensity = 0; u.prio = 0; }
      } else if (l.intensity !== 0) {
        l.intensity = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
/** Short-lived additive tracer streaks. The tail races toward the impact point while the streak fades. */
export class Tracers {
  constructor(cap = 64) {
    this.cap = cap;
    this.count = 0;
    this.d = new Float32Array(cap * 11); // fx,fy,fz, tx,ty,tz, age, life, r,g,b
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 6);
    this.col = new Float32Array(cap * 6);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.name = 'fx_tracers';
  }

  add(fx, fy, fz, tx, ty, tz, r, g, b) {
    let i = this.count < this.cap ? this.count++ : Math.floor(Math.random() * this.cap);
    const o = i * 11, D = this.d;
    const dist = Math.hypot(tx - fx, ty - fy, tz - fz);
    D[o] = fx; D[o + 1] = fy; D[o + 2] = fz; D[o + 3] = tx; D[o + 4] = ty; D[o + 5] = tz;
    D[o + 6] = 0; D[o + 7] = Math.min(0.13, 0.06 + dist / 2600);
    D[o + 8] = r; D[o + 9] = g; D[o + 10] = b;
  }

  update(dt) {
    const D = this.d, P = this.pos, C = this.col;
    let i = 0;
    while (i < this.count) {
      const o = i * 11;
      D[o + 6] += dt;
      const t = D[o + 6] / D[o + 7];
      if (t >= 1) {
        const last = --this.count;
        if (i !== last) { const s = last * 11; for (let k = 0; k < 11; k++) D[o + k] = D[s + k]; }
        continue;
      }
      const tail = Math.pow(t, 0.6);
      const p = i * 6;
      const fx = D[o], fy = D[o + 1], fz = D[o + 2], tx = D[o + 3], ty = D[o + 4], tz = D[o + 5];
      P[p] = fx + (tx - fx) * tail; P[p + 1] = fy + (ty - fy) * tail; P[p + 2] = fz + (tz - fz) * tail;
      P[p + 3] = tx; P[p + 4] = ty; P[p + 5] = tz;
      const k = 1 - t;
      C[p] = D[o + 8] * k * 0.25; C[p + 1] = D[o + 9] * k * 0.25; C[p + 2] = D[o + 10] * k * 0.25;
      C[p + 3] = D[o + 8] * k; C[p + 4] = D[o + 9] * k; C[p + 5] = D[o + 10] * k;
      i++;
    }
    this.mesh.geometry.setDrawRange(0, this.count * 2);
    if (this.count > 0 || this._was) { this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; }
    this._was = this.count > 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
/** 32x16 texture: left tile = 8-point star burst (front), right tile = flame cone (side view). Additive. */
function flashTexture() {
  const W = 32, H = 16, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      if (x < 16) {
        const dx = Math.abs(x - 7.5), dy = Math.abs(y - 7.5);
        const cheb = Math.max(dx, dy), man = dx + dy;
        if (cheb < 1.6) v = 1;
        else if ((dx < 1 && dy < 7) || (dy < 1 && dx < 7)) v = 1 - Math.max(dx, dy) / 8;
        else if (Math.abs(dx - dy) < 1 && man < 9) v = 0.8 - man / 12;
        else if (cheb < 3.5) v = 0.55;
      } else {
        const lx = x - 16, dy = Math.abs(y - 7.5);
        // cone from the left (muzzle) to the right (tip)
        const w = 6.5 * (1 - lx / 16) + 0.5;
        if (dy < w) v = (1 - lx / 17) * (1 - dy / (w + 1)) * 1.2;
      }
      v = Math.max(0, Math.min(1, v));
      const i = (y * W + x) * 4;
      data[i] = Math.round(255 * v);
      data[i + 1] = Math.round(225 * v * v + 20 * v);
      data[i + 2] = Math.round(140 * v * v * v);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** One quad facing +Z (star) + two crossed quads along +Z (flame cones). Unit size, built for a muzzle at origin. */
function flashGeometry() {
  const pos = [], uv = [], idx = [];
  let v = 0;
  const quad = (p, t) => { pos.push(...p); uv.push(...t); idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
  const s = 0.5;
  quad([-s, -s, 0.05, s, -s, 0.05, s, s, 0.05, -s, s, 0.05], [0, 0, 0.5, 0, 0.5, 1, 0, 1]);
  const L = 1.6;
  quad([0, -s, 0, 0, -s, L, 0, s, L, 0, s, 0], [0.5, 0, 1, 0, 1, 1, 0.5, 1]);
  quad([-s, 0, 0, -s, 0, L, s, 0, L, s, 0, 0], [0.5, 0, 1, 0, 1, 1, 0.5, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _alt = new THREE.Vector3(1, 0, 0);

export class MuzzleFlashes {
  constructor(count = 8) {
    const geo = flashGeometry();
    const mat = new THREE.MeshBasicMaterial({
      map: flashTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'fx_muzzle';
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.matrixAutoUpdate = false;
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 14;
      m.userData = { t: 0, life: 0.05, size: 0.4, px: 0, py: 0, pz: 0 };
      this.group.add(m);
      this.items.push(m);
    }
    this._next = 0;
  }

  add(pos, dir, size = 0.45) {
    const m = this.items[this._next];
    this._next = (this._next + 1) % this.items.length;
    const u = m.userData;
    u.t = 0; u.life = 0.045 + Math.random() * 0.02; u.size = size * (0.8 + Math.random() * 0.45);
    _bz.copy(dir);
    if (_bz.lengthSq() < 1e-6) _bz.set(0, 0, 1);
    _bz.normalize();
    _bx.crossVectors(Math.abs(_bz.y) > 0.95 ? _alt : _up, _bz).normalize();
    _by.crossVectors(_bz, _bx);
    // random roll
    const r = Math.random() * Math.PI;
    const c = Math.cos(r), s = Math.sin(r);
    const xx = _bx.x * c + _by.x * s, xy = _bx.y * c + _by.y * s, xz = _bx.z * c + _by.z * s;
    const yx = _by.x * c - _bx.x * s, yy = _by.y * c - _bx.y * s, yz = _by.z * c - _bx.z * s;
    m.matrix.set(xx, yx, _bz.x, pos.x, xy, yy, _bz.y, pos.y, xz, yz, _bz.z, pos.z, 0, 0, 0, 1);
    u.px = pos.x; u.py = pos.y; u.pz = pos.z;
    u.basis = u.basis || new Float32Array(9);
    u.basis[0] = xx; u.basis[1] = xy; u.basis[2] = xz; u.basis[3] = yx; u.basis[4] = yy; u.basis[5] = yz;
    u.basis[6] = _bz.x; u.basis[7] = _bz.y; u.basis[8] = _bz.z;
    m.visible = true;
    this._apply(m, 1);
  }

  _apply(m, k) {
    const u = m.userData, b = u.basis, s = u.size * k, e = m.matrix.elements;
    e[0] = b[0] * s; e[1] = b[1] * s; e[2] = b[2] * s;
    e[4] = b[3] * s; e[5] = b[4] * s; e[6] = b[5] * s;
    e[8] = b[6] * s; e[9] = b[7] * s; e[10] = b[8] * s;
    e[12] = u.px; e[13] = u.py; e[14] = u.pz;
    m.matrixWorldNeedsUpdate = true;
  }

  update(dt) {
    for (const m of this.items) {
      if (!m.visible) continue;
      const u = m.userData;
      u.t += dt;
      if (u.t >= u.life) { m.visible = false; continue; }
      const k = 1 - u.t / u.life;
      this._apply(m, 0.55 + 0.45 * k);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
/** Bullet holes / scorch marks: small dark quads stuck on block faces, removed when their block disappears. */
export class Decals {
  constructor(cap = 120) {
    this.cap = cap;
    this.count = 0;
    this.next = 0;
    this.data = new Float32Array(cap * 12); // x,y,z, nx,ny,nz, size, age, life, bx,by,bz
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false, transparent: true, opacity: 0.88,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'fx_decals';
    this._check = 0;
  }

  add(x, y, z, nx, ny, nz, size, life, bx, by, bz, shade = 0.12) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else { i = this.next; this.next = (this.next + 1) % this.cap; }
    const o = i * 12, D = this.data;
    D[o] = x + nx * 0.012; D[o + 1] = y + ny * 0.012; D[o + 2] = z + nz * 0.012;
    D[o + 3] = nx; D[o + 4] = ny; D[o + 5] = nz;
    D[o + 6] = size; D[o + 7] = 0; D[o + 8] = life;
    D[o + 9] = bx; D[o + 10] = by; D[o + 11] = bz;
    const C = this.mesh.instanceColor.array;
    C[i * 3] = shade; C[i * 3 + 1] = shade * 0.95; C[i * 3 + 2] = shade * 0.9;
    this.mesh.instanceColor.needsUpdate = true;
    this._write(i, 1);
    this._added = true;
  }

  _write(i, k) {
    const D = this.data, o = i * 12, M = this.mesh.instanceMatrix.array, m = i * 16;
    const nx = D[o + 3], ny = D[o + 4], nz = D[o + 5], s = D[o + 6] * k;
    // basis: z = normal, x = any perpendicular
    let xx, xy, xz;
    if (Math.abs(ny) > 0.9) { xx = 1; xy = 0; xz = 0; } else { xx = nz; xy = 0; xz = -nx; const l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l; }
    const yx = ny * xz - nz * xy, yy = nz * xx - nx * xz, yz = nx * xy - ny * xx;
    M[m] = xx * s; M[m + 1] = xy * s; M[m + 2] = xz * s; M[m + 3] = 0;
    M[m + 4] = yx * s; M[m + 5] = yy * s; M[m + 6] = yz * s; M[m + 7] = 0;
    M[m + 8] = nx; M[m + 9] = ny; M[m + 10] = nz; M[m + 11] = 0;
    M[m + 12] = D[o]; M[m + 13] = D[o + 1]; M[m + 14] = D[o + 2]; M[m + 15] = 1;
  }

  _remove(i) {
    const last = --this.count;
    if (i !== last) {
      const D = this.data;
      for (let k = 0; k < 12; k++) D[i * 12 + k] = D[last * 12 + k];
      const C = this.mesh.instanceColor.array;
      C[i * 3] = C[last * 3]; C[i * 3 + 1] = C[last * 3 + 1]; C[i * 3 + 2] = C[last * 3 + 2];
      this.mesh.instanceColor.needsUpdate = true;
    }
    if (this.next >= this.count) this.next = 0;
  }

  update(dt, world) {
    const D = this.data;
    let dirty = false;
    let i = 0;
    while (i < this.count) {
      const o = i * 12;
      D[o + 7] += dt;
      const t = D[o + 7], life = D[o + 8];
      if (t >= life) { this._remove(i); dirty = true; continue; }
      if (t > life - 1) { this._write(i, life - t); dirty = true; }
      i++;
    }
    // drop decals whose block got removed (round-robin, a few per frame)
    if (world && world.getBlock && this.count > 0) {
      for (let n = 0; n < 4 && this.count > 0; n++) {
        this._check = (this._check + 1) % this.count;
        const o = this._check * 12;
        const id = world.getBlock(D[o + 9], D[o + 10], D[o + 11]);
        if (!id) { this._remove(this._check); dirty = true; }
      }
    }
    if (dirty) {
      for (let k = 0; k < this.count; k++) if (D[k * 12 + 7] <= D[k * 12 + 8] - 1) this._write(k, 1);
      this.mesh.instanceMatrix.needsUpdate = true;
    } else if (this._added) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this._added = false;
    this.mesh.count = this.count;
  }
}
