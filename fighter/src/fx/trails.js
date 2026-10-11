// TrailField: Absolver-like limb swing trails. A short tapered ribbon follows a fighter's strike point (hand / foot /
// elbow / knee) through the last part of the wind-up and the active frames, pale white with a hint of the fighter's
// accent, mostly additive, each sample fading out over ~0.12 s of SIMULATION time (so trails freeze with hitstop and
// linger in slow motion). All trails live in one dynamic mesh = one draw call; Catmull-Rom subdivision keeps arcs
// smooth at 60 Hz. When a chained follow-up holds the strike pose (§6b), emission stops and the trail fades on the held
// form, so the last attack's shape visibly lingers for a beat before the next move begins.
import * as THREE from 'three';
import { makeFxMaterial, markRange } from './material.js';

const MAXT = 10;        // trail slots
const MAXS = 24;        // samples per trail
const SUB = 3;          // Catmull-Rom sub-steps per segment
const MAXP = (MAXS - 1) * SUB + 1;
const FREE = 0, ARMED = 1, EMIT = 2, FADE = 3;

export class TrailField {
  constructor() {
    this.state = new Uint8Array(MAXT);
    this.fighter = new Array(MAXT).fill(null);
    this.move = new Array(MAXT).fill(null);
    this.limb = new Array(MAXT).fill('handR');
    this.t0 = new Float32Array(MAXT);         // move-time window [t0, t1] (auto mode)
    this.t1 = new Float32Array(MAXT);
    this.until = new Float64Array(MAXT);      // game.time until which emission is forced (combat's trail() call)
    this.manual = new Uint8Array(MAXT);
    this.life = new Float32Array(MAXT);
    this.width = new Float32Array(MAXT);
    this.alpha = new Float32Array(MAXT);
    this.tint = new Float32Array(MAXT * 3);   // accent (display RGB)
    this.stamp = new Float64Array(MAXT);
    this.n = new Uint8Array(MAXT);
    this.s = new Float32Array(MAXT * MAXS * 4);   // x, y, z, age (oldest first)
    this._serial = 0;
    this._p = new THREE.Vector3();
    this._pts = new Float32Array(MAXP * 4);

    const maxV = MAXT * MAXP * 2;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(maxV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(new Float32Array(maxV * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(maxV * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aShp = new THREE.BufferAttribute(new Float32Array(maxV * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.index = new THREE.BufferAttribute(new Uint16Array(MAXT * (MAXP - 1) * 6), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aUv', this.aUv);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aShape', this.aShp);
    g.setIndex(this.index);
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, makeFxMaterial());
    this.mesh.name = 'fx-trails';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 29;
    this.mesh.visible = false;
  }

  _alloc() {
    for (let i = 0; i < MAXT; i++) if (this.state[i] === FREE) return i;
    // steal the oldest
    let best = 0;
    for (let i = 1; i < MAXT; i++) if (this.stamp[i] < this.stamp[best]) best = i;
    return best;
  }

  _init(i, f, move, limb, o) {
    this.state[i] = ARMED;
    this.fighter[i] = f; this.move[i] = move; this.limb[i] = limb || 'handR';
    this.n[i] = 0;
    this.manual[i] = 0;
    this.until[i] = -1;
    this.life[i] = o.life; this.width[i] = o.width; this.alpha[i] = o.alpha;
    this.tint[i * 3] = o.r; this.tint[i * 3 + 1] = o.g; this.tint[i * 3 + 2] = o.b;
    this.stamp[i] = ++this._serial;
  }

  /** Auto trail: emit while f performs `move` with moveTime in [t0, t1] (and not holding the strike pose). */
  arm(f, move, limb, t0, t1, o) {
    const i = this._alloc();
    this._init(i, f, move, limb, o);
    this.t0[i] = t0; this.t1[i] = t1;
    return i;
  }

  /** Force emission of f's `limb` trail for `seconds` of sim time (extends an armed / emitting trail if any). */
  extend(f, limb, seconds, now, o) {
    let best = -1;
    for (let i = 0; i < MAXT; i++) {
      if (this.fighter[i] !== f || this.limb[i] !== limb) continue;
      const st = this.state[i];
      if (st === EMIT) { best = i; break; }
      if (st === ARMED && best < 0) best = i;
    }
    if (best < 0) {
      best = this._alloc();
      this._init(best, f, f && f.move, limb, o);
      this.manual[best] = 1;
      this.state[best] = EMIT;
    }
    this.until[best] = Math.max(this.until[best], now + Math.max(0.02, seconds));
    return best;
  }

  /** Drop every trail of a fighter (removed / reset). */
  release(f) { for (let i = 0; i < MAXT; i++) if (this.fighter[i] === f) this._free(i); }

  clear() { for (let i = 0; i < MAXT; i++) this._free(i); this.geometry.setDrawRange(0, 0); this.mesh.visible = false; }

  _free(i) { this.state[i] = FREE; this.fighter[i] = null; this.move[i] = null; this.n[i] = 0; }

  get active() { let c = 0; for (let i = 0; i < MAXT; i++) if (this.state[i] !== FREE) c++; return c; }

  /** simDt: simulation seconds since the last frame (0 during hitstop / pause). now: game.time. */
  update(simDt, now, camera) {
    let anyLive = false;
    for (let i = 0; i < MAXT; i++) {
      const st = this.state[i];
      if (st === FREE) continue;
      const f = this.fighter[i];
      if (!f || f.removed || !f.animator || typeof f.animator.strikePoint !== 'function') { this._free(i); continue; }
      // emission decision
      let emit = false;
      if (st === ARMED || st === EMIT) {
        const hold = !!(f.atk && f.atk.phase === 'hold');
        const inMove = f.state === 'attack' && f.move === this.move[i];
        if (this.manual[i]) emit = now <= this.until[i] && !hold && f.alive;
        else if (inMove && !hold) {
          const mt = f.moveTime;
          emit = (mt >= this.t0[i] && mt <= this.t1[i]) || (now <= this.until[i] && mt >= this.t0[i]);
          if (!emit && st === ARMED && mt < this.t0[i]) { anyLive = true; continue; }   // still waiting for the swing
        }
        if (!emit) {
          if (st === ARMED) { this._free(i); continue; }
          this.state[i] = FADE;
        } else this.state[i] = EMIT;
      }
      // age + expire samples (oldest first)
      const base = i * MAXS * 4, life = this.life[i];
      let n = this.n[i];
      if (simDt > 0) for (let k = 0; k < n; k++) this.s[base + k * 4 + 3] += simDt;
      let drop = 0;
      while (drop < n && this.s[base + drop * 4 + 3] >= life) drop++;
      if (drop > 0) {
        this.s.copyWithin(base, base + drop * 4, base + n * 4);
        n -= drop;
      }
      if (emit) {
        const p = f.animator.strikePoint(this.limb[i], this._p);
        if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
          let add = true;
          if (n > 0) {
            const o = base + (n - 1) * 4;
            const dx = p.x - this.s[o], dy = p.y - this.s[o + 1], dz = p.z - this.s[o + 2];
            if (dx * dx + dy * dy + dz * dz < 1.6e-5) add = false;     // limb not moving (hitstop): no new sample
          }
          if (add) {
            if (n >= MAXS) { this.s.copyWithin(base, base + 4, base + n * 4); n--; }
            const o = base + n * 4;
            this.s[o] = p.x; this.s[o + 1] = p.y; this.s[o + 2] = p.z; this.s[o + 3] = 0;
            n++;
          }
        }
      }
      this.n[i] = n;
      if (this.state[i] === FADE && n === 0) { this._free(i); continue; }
      anyLive = true;
    }
    if (!anyLive) { if (this.mesh.visible) { this.geometry.setDrawRange(0, 0); this.mesh.visible = false; } return; }
    this._build(camera);
  }

  _build(camera) {
    const e = camera.matrixWorld.elements;
    const cx = e[12], cy = e[13], cz = e[14];
    const P = this.aPos.array, U = this.aUv.array, C = this.aCol.array, S = this.aShp.array, I = this.index.array;
    const pts = this._pts;
    let v = 0, ic = 0;
    for (let i = 0; i < MAXT; i++) {
      const n = this.n[i];
      if (this.state[i] === FREE || n < 2) continue;
      const base = i * MAXS * 4, s = this.s;
      // Catmull-Rom resample (centripetal-ish uniform; ages lerped)
      let m = 0;
      for (let k = 0; k < n - 1; k++) {
        const k0 = Math.max(0, k - 1), k2 = k + 1, k3 = Math.min(n - 1, k + 2);
        const o0 = base + k0 * 4, o1 = base + k * 4, o2 = base + k2 * 4, o3 = base + k3 * 4;
        for (let j = 0; j < SUB; j++) {
          const t = j / SUB, t2 = t * t, t3 = t2 * t;
          const a0 = -0.5 * t3 + t2 - 0.5 * t, a1 = 1.5 * t3 - 2.5 * t2 + 1, a2 = -1.5 * t3 + 2 * t2 + 0.5 * t, a3 = 0.5 * t3 - 0.5 * t2;
          const q = m * 4;
          pts[q] = s[o0] * a0 + s[o1] * a1 + s[o2] * a2 + s[o3] * a3;
          pts[q + 1] = s[o0 + 1] * a0 + s[o1 + 1] * a1 + s[o2 + 1] * a2 + s[o3 + 1] * a3;
          pts[q + 2] = s[o0 + 2] * a0 + s[o1 + 2] * a1 + s[o2 + 2] * a2 + s[o3 + 2] * a3;
          pts[q + 3] = s[o1 + 3] + (s[o2 + 3] - s[o1 + 3]) * t;
          m++;
        }
      }
      { const q = m * 4, o = base + (n - 1) * 4; pts[q] = s[o]; pts[q + 1] = s[o + 1]; pts[q + 2] = s[o + 2]; pts[q + 3] = s[o + 3]; m++; }
      const life = this.life[i], w0 = this.width[i], a0 = this.alpha[i];
      const tr = this.tint[i * 3], tg = this.tint[i * 3 + 1], tb = this.tint[i * 3 + 2];
      const v0 = v;
      for (let k = 0; k < m; k++) {
        const q = k * 4;
        const px = pts[q], py = pts[q + 1], pz = pts[q + 2];
        const kp = k > 0 ? k - 1 : k, kn = k < m - 1 ? k + 1 : k;
        let tx = pts[kn * 4] - pts[kp * 4], ty = pts[kn * 4 + 1] - pts[kp * 4 + 1], tz = pts[kn * 4 + 2] - pts[kp * 4 + 2];
        const vx = cx - px, vy = cy - py, vz = cz - pz;
        let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
        const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (sl < 1e-7) { sx = 0; sy = 1; sz = 0; } else { sx /= sl; sy /= sl; sz /= sl; }
        const u = Math.min(1, pts[q + 3] / life);
        const head = (m - 1 - k) / SUB;                     // distance from the newest point in samples
        const taper = Math.pow(1 - u, 0.75) * (0.45 + 0.55 * Math.min(1, head * 0.9 + 0.25));
        const w = w0 * taper;
        const al = a0 * Math.pow(1 - u, 1.35);
        const mix = 0.18 + 0.5 * u;                          // the tail takes more of the accent
        const r = 1 + (tr - 1) * mix, g = 1 + (tg - 1) * mix, b = 1 + (tb - 1) * mix;
        const p3 = v * 3;
        P[p3] = px + sx * w; P[p3 + 1] = py + sy * w; P[p3 + 2] = pz + sz * w;
        P[p3 + 3] = px - sx * w; P[p3 + 4] = py - sy * w; P[p3 + 5] = pz - sz * w;
        const u2 = v * 2;
        U[u2] = 0; U[u2 + 1] = 1; U[u2 + 2] = 0; U[u2 + 3] = -1;
        const c4 = v * 4;
        C[c4] = r; C[c4 + 1] = g; C[c4 + 2] = b; C[c4 + 3] = al;
        C[c4 + 4] = r; C[c4 + 5] = g; C[c4 + 6] = b; C[c4 + 7] = al;
        S[c4] = 4; S[c4 + 1] = 0; S[c4 + 2] = 0.45; S[c4 + 3] = 0;
        S[c4 + 4] = 4; S[c4 + 5] = 0; S[c4 + 6] = 0.45; S[c4 + 7] = 0;
        v += 2;
      }
      for (let k = 0; k < m - 1; k++) {
        const b = v0 + k * 2;
        I[ic++] = b; I[ic++] = b + 1; I[ic++] = b + 3;
        I[ic++] = b; I[ic++] = b + 3; I[ic++] = b + 2;
      }
    }
    if (ic === 0) { this.geometry.setDrawRange(0, 0); this.mesh.visible = false; return; }
    this.mesh.visible = true;
    markRange(this.aPos, v * 3);
    markRange(this.aUv, v * 2);
    markRange(this.aCol, v * 4);
    markRange(this.aShp, v * 4);
    markRange(this.index, ic);
    this.geometry.setDrawRange(0, ic);
  }
}
