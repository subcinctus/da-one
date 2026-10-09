// Pooled cube particles (owned by ATMOSPHERE). One InstancedMesh per pool = one draw call.
// Struct-of-arrays state, packed live range [0, count) with swap-remove, zero allocations per frame.
//
// Three flavours share this class (chosen by the material passed in):
//   'solid'  MeshLambert cubes with per-instance colour (debris, blood, droplets)
//   'glow'   additive unlit cubes; colour fades to black over life (fire, sparks, fireballs)
//   'smoke'  alpha-blended shaded cubes with a per-instance alpha attribute (smoke, dust, foam)
//   'fire'   opaque unlit cubes (fireballs, flames): saturated colours that read even against a bright sky
import * as THREE from 'three';

/** Reusable spawn spec. Callers fill the fields they need; reset() restores defaults. */
export class ParticleSpec {
  constructor() { this.reset(); }
  reset() {
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.gravity = 0;      // m/s² downward (negative = buoyant)
    this.drag = 0;         // 1/s exponential velocity damping
    this.life = 1;         // seconds
    this.size0 = 0.2;      // size at birth (after pop-in)
    this.size1 = 0.2;      // size at death
    this.sizePow = 1;      // size curve exponent (t^pow)
    this.popIn = 0;        // fraction of life over which the particle grows from 0
    this.r = 1; this.g = 1; this.b = 1;        // start colour (linear)
    this.r1 = -1; this.g1 = 0; this.b1 = 0;    // end colour (r1 < 0 = same as start)
    this.colorPow = 1;
    this.alpha = 1;        // smoke: peak alpha
    this.fadeStart = 0.35; // smoke: start of the fade-out (fraction of life)
    this.fadeIn = 0.08;    // smoke: fraction of life spent fading in
    this.spin = 0;         // max random angular speed (rad/s)
    this.rot0 = Math.PI;   // max random initial rotation per axis (rad) when spin > 0
    this.stretch = 0;      // >0: align with velocity and elongate by speed*stretch (sparks)
    this.collide = false;  // bounce on the voxel floor
    this.bounce = 0.3;
    this.killBelow = -1e9; // die when y drops below this (water droplets)
    return this;
  }
}

export class ParticlePool {
  /**
   * @param {number} cap
   * @param {THREE.Material} material
   * @param {'solid'|'glow'|'smoke'|'fire'} kind
   */
  constructor(cap, material, kind) {
    this.cap = cap;
    this.kind = kind;
    this.count = 0;
    this._cursor = 0;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.grav = f(); this.drag = f();
    this.age = f(); this.life = f();
    this.s0 = f(); this.s1 = f(); this.sPow = f(); this.pop = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.er = f(); this.eg = f(); this.eb = f(); this.cPow = f();
    this.a0 = f(); this.fade = f(); this.fin = f();
    this.rx = f(); this.ry = f(); this.rz = f();
    this.wx = f(); this.wy = f(); this.wz = f();
    this.stretch = f(); this.bounce = f(); this.killBelow = f();
    this.floorY = f();
    this.colX = new Int32Array(cap); this.colZ = new Int32Array(cap);
    this.flags = new Uint8Array(cap); // bit0: collide with the voxel floor

    const geo = new THREE.BoxGeometry(1, 1, 1);
    if (kind === 'smoke') {
      this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAlpha', this.alphaAttr);
    }
    const mesh = new THREE.InstancedMesh(geo, material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'fx_' + kind;
    if (kind === 'glow') mesh.renderOrder = 12;
    if (kind === 'fire') mesh.renderOrder = 1;
    if (kind === 'smoke') mesh.renderOrder = 11;
    this.mesh = mesh;
  }

  /** Spawn a particle from a spec. Returns its index (or -1 when the pool is full and drops new particles). */
  emit(s) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else if (this.kind === 'smoke') return -1; // smoke drops instead of popping old puffs
    else { i = this._cursor; this._cursor = (this._cursor + 1) % this.cap; }
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    this.grav[i] = s.gravity; this.drag[i] = s.drag;
    this.age[i] = 0; this.life[i] = Math.max(0.01, s.life);
    this.s0[i] = s.size0; this.s1[i] = s.size1; this.sPow[i] = s.sizePow; this.pop[i] = s.popIn;
    this.cr[i] = s.r; this.cg[i] = s.g; this.cb[i] = s.b;
    if (s.r1 < 0) { this.er[i] = s.r; this.eg[i] = s.g; this.eb[i] = s.b; } else { this.er[i] = s.r1; this.eg[i] = s.g1; this.eb[i] = s.b1; }
    this.cPow[i] = s.colorPow;
    this.a0[i] = s.alpha; this.fade[i] = s.fadeStart; this.fin[i] = Math.max(0.001, s.fadeIn);
    const sp = s.spin;
    if (sp > 0) {
      const r0 = s.rot0;
      this.rx[i] = (Math.random() * 2 - 1) * r0; this.ry[i] = (Math.random() * 2 - 1) * r0 * 2; this.rz[i] = (Math.random() * 2 - 1) * r0;
      this.wx[i] = (Math.random() * 2 - 1) * sp; this.wy[i] = (Math.random() * 2 - 1) * sp; this.wz[i] = (Math.random() * 2 - 1) * sp;
    } else {
      this.rx[i] = this.ry[i] = this.rz[i] = 0; this.wx[i] = this.wy[i] = this.wz[i] = 0;
    }
    this.stretch[i] = s.stretch;
    this.bounce[i] = s.bounce;
    this.killBelow[i] = s.killBelow;
    this.flags[i] = s.collide ? 1 : 0;
    this.colX[i] = 0x7fffffff; this.colZ[i] = 0x7fffffff; this.floorY[i] = -1e9;
    return i;
  }

  _copy(dst, src) {
    const arrs = this._arrays || (this._arrays = [
      this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.grav, this.drag, this.age, this.life,
      this.s0, this.s1, this.sPow, this.pop, this.cr, this.cg, this.cb, this.er, this.eg, this.eb, this.cPow,
      this.a0, this.fade, this.fin, this.rx, this.ry, this.rz, this.wx, this.wy, this.wz, this.stretch, this.bounce,
      this.killBelow, this.floorY, this.colX, this.colZ, this.flags]);
    for (let k = 0; k < arrs.length; k++) arrs[k][dst] = arrs[k][src];
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  /** Find the standing height under (x, y, z) by scanning the column downward (cached per particle column). */
  _floor(world, i, x, y, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    if (bx === this.colX[i] && bz === this.colZ[i]) return this.floorY[i];
    this.colX[i] = bx; this.colZ[i] = bz;
    let fy = -1e9;
    const top = Math.floor(y + 0.5);
    for (let by = top; by >= top - 14 && by >= 0; by--) {
      if (world.isSolid(bx, by, bz)) { fy = by + 1; break; }
    }
    this.floorY[i] = fy;
    return fy;
  }

  /** Integrate, collide, write instance buffers. light = colour multiplier for smoke (scene brightness). */
  update(dt, world, light = 1) {
    const M = this.mesh.instanceMatrix.array;
    const C = this.mesh.instanceColor.array;
    const A = this.alphaAttr ? this.alphaAttr.array : null;
    const glow = this.kind === 'glow';
    let i = 0;
    while (i < this.count) {
      const age = this.age[i] + dt;
      const life = this.life[i];
      if (age >= life || this.py[i] < this.killBelow[i]) {
        const last = --this.count;
        if (i !== last) this._copy(i, last);
        continue;
      }
      this.age[i] = age;
      const t = age / life;
      // integrate
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      const dr = this.drag[i];
      if (dr > 0) { const k = Math.exp(-dr * dt); vx *= k; vy *= k; vz *= k; }
      vy -= this.grav[i] * dt;
      let x = this.px[i] + vx * dt, y = this.py[i] + vy * dt, z = this.pz[i] + vz * dt;
      // size
      const pop = this.pop[i];
      let size = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.pow(t, this.sPow[i]);
      if (pop > 0 && t < pop) size *= t / pop;
      // floor collision (debris)
      if ((this.flags[i] & 1) && world && vy <= 0) {
        const fy = this._floor(world, i, x, this.py[i], z);
        const half = size * 0.5;
        if (y - half < fy) {
          y = fy + half;
          const b = this.bounce[i];
          vy = -vy * b;
          if (vy < 0.6) vy = 0;
          const fr = Math.exp(-7 * dt);
          vx *= fr; vz *= fr;
          this.wx[i] *= 0.7; this.wy[i] *= 0.7; this.wz[i] *= 0.7;
        }
      }
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;

      // colour
      const ct = this.cPow[i] === 1 ? t : Math.pow(t, this.cPow[i]);
      let r = this.cr[i] + (this.er[i] - this.cr[i]) * ct;
      let g = this.cg[i] + (this.eg[i] - this.cg[i]) * ct;
      let b = this.cb[i] + (this.eb[i] - this.cb[i]) * ct;
      if (glow) { const f = 1 - t; const k = f * f * (3 - 2 * f); r *= k; g *= k; b *= k; }
      else if (A) {
        r *= light; g *= light; b *= light;
        const fs = this.fade[i];
        const fi = this.fin[i];
        const fin = t < fi ? t / fi : 1;
        const fout = t > fs ? 1 - (t - fs) / (1 - fs) : 1;
        A[i] = this.a0[i] * fin * fout;
      }
      const ci = i * 3;
      C[ci] = r; C[ci + 1] = g; C[ci + 2] = b;

      // matrix
      const o = i * 16;
      const st = this.stretch[i];
      const sp2 = vx * vx + vy * vy + vz * vz;
      if (st > 0 && sp2 > 1e-4) {
        // velocity-aligned streak
        const sp = Math.sqrt(sp2);
        const zx = vx / sp, zy = vy / sp, zz = vz / sp;
        // x = normalize(cross(up, z)) with a fallback when z is vertical
        let xx = zz, xy = 0, xz = -zx;
        let xl = Math.sqrt(xx * xx + xz * xz);
        if (xl < 1e-3) { xx = 1; xy = 0; xz = 0; xl = 1; }
        xx /= xl; xz /= xl;
        const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
        const len = size * (1 + sp * st);
        M[o] = xx * size; M[o + 1] = xy * size; M[o + 2] = xz * size; M[o + 3] = 0;
        M[o + 4] = yx * size; M[o + 5] = yy * size; M[o + 6] = yz * size; M[o + 7] = 0;
        M[o + 8] = zx * len; M[o + 9] = zy * len; M[o + 10] = zz * len; M[o + 11] = 0;
      } else {
        let ax = this.rx[i], ay = this.ry[i], az = this.rz[i];
        const wx = this.wx[i], wy = this.wy[i], wz = this.wz[i];
        if (wx !== 0 || wy !== 0 || wz !== 0 || ax !== 0 || ay !== 0 || az !== 0) {
          ax += wx * dt; ay += wy * dt; az += wz * dt;
          this.rx[i] = ax; this.ry[i] = ay; this.rz[i] = az;
          const a = Math.cos(ax), bb = Math.sin(ax), c = Math.cos(ay), d = Math.sin(ay), e = Math.cos(az), f = Math.sin(az);
          const ae = a * e, af = a * f, be = bb * e, bf = bb * f;
          M[o] = c * e * size; M[o + 1] = (af + be * d) * size; M[o + 2] = (bf - ae * d) * size; M[o + 3] = 0;
          M[o + 4] = -c * f * size; M[o + 5] = (ae - bf * d) * size; M[o + 6] = (be + af * d) * size; M[o + 7] = 0;
          M[o + 8] = d * size; M[o + 9] = -bb * c * size; M[o + 10] = a * c * size; M[o + 11] = 0;
        } else {
          M[o] = size; M[o + 1] = 0; M[o + 2] = 0; M[o + 3] = 0;
          M[o + 4] = 0; M[o + 5] = size; M[o + 6] = 0; M[o + 7] = 0;
          M[o + 8] = 0; M[o + 9] = 0; M[o + 10] = size; M[o + 11] = 0;
        }
      }
      M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
      i++;
    }
    this.mesh.count = this.count;
    if (this.count > 0 || this._wasLive) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      if (this.alphaAttr) this.alphaAttr.needsUpdate = true;
    }
    this._wasLive = this.count > 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Materials
export function createSolidMaterial() {
  return new THREE.MeshLambertMaterial({ color: 0xffffff });
}

export function createFireMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true, toneMapped: false });
}

export function createGlowMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  });
}

const SMOKE_VERT = /* glsl */`
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  vColor = instanceColor;
  vAlpha = aAlpha;
  vec3 n = normalize(mat3(instanceMatrix) * normal);
  vShade = 0.78 + 0.22 * n.y + 0.08 * n.x;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const SMOKE_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  if (vAlpha < 0.004) discard;
  gl_FragColor = vec4(vColor * vShade, vAlpha);
  #include <fog_fragment>
  #include <colorspace_fragment>
}`;

export function createSmokeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: SMOKE_VERT,
    fragmentShader: SMOKE_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}
