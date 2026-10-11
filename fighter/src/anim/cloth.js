// Cheap secondary motion for cloth bones (sash tails, tunic flaps): 2-segment angular springs per chain, driven by
// gravity in the hips' frame, air drag from body velocity and (for flaps) the thighs so kicks lift them.
// Allocation-free per step.
import * as THREE from 'three';
import { JOINT_INDEX } from './rig.js';

const Y = new THREE.Vector3(0, 1, 0);
const _qh = new THREE.Quaternion();
const _ql = new THREE.Quaternion();
const _g = new THREE.Vector3();
const _d = new THREE.Vector3();
const HIPS = JOINT_INDEX.hips, THL = JOINT_INDEX.thighL, THR = JOINT_INDEX.thighR;

const readQ = (buf, i, q) => { const o = i * 4; return q.set(buf.q[o], buf.q[o + 1], buf.q[o + 2], buf.q[o + 3]); };
/** Approximate pitch (X rotation) of a mostly-X joint rotation. */
const pitchOf = (buf, i) => { const o = i * 4; return 2 * Math.atan2(buf.q[o], buf.q[o + 3]); };

const KINDS = {
  flapF: { drag: 0.16, k1: 170, c1: 10, k2: 130, c2: 7, rollMax: 0.25, pMin: -1.6, pMax: 0.9 },
  flapB: { drag: 0.2, k1: 150, c1: 9, k2: 120, c2: 6.5, rollMax: 0.25, pMin: -0.9, pMax: 1.6 },
  sash: { drag: 0.32, k1: 110, c1: 6, k2: 90, c2: 4.5, rollMax: 1.2, pMin: -1.4, pMax: 1.4 },
};

export class ClothSim {
  constructor(model) {
    this.chains = [];
    const cloth = model?.cloth || [];
    const bones = model?.skeleton?.cloth || {};
    const groups = {};
    for (const c of cloth) {
      const key = c.bone.slice(0, -1);
      (groups[key] || (groups[key] = { kind: c.kind === 'sash' ? 'sash' : c.kind, b1: null, b2: null }))[c.seg ? 'b2' : 'b1'] = bones[c.bone] || null;
    }
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      if (!g.b1) continue;
      const kind = KINDS[g.kind] ? g.kind : 'sash';
      this.chains.push({ key, kind, K: KINDS[kind], flap: kind === 'flapF' ? 1 : kind === 'flapB' ? 2 : 0, b1: g.b1, b2: g.b2, p1: 0.1, r1: 0.1, vp1: 0.1, vr1: 0.1, p2: 0.1, r2: 0.1, vp2: 0.1, vr2: 0.1,
        pp1: 0.1, pr1: 0.1, pp2: 0.1, pr2: 0.1, side: key === 'sashB' ? 1 : 0 });
    }
    this.fresh = true;
  }

  /**
   * Step the springs. out: displayed PoseBuffer; (vx, vy, vz): body velocity in fighter space (x = own left, m/s).
   */
  update(dt, out, vx, vy, vz) {
    if (!this.chains.length) return;
    _qh.setFromAxisAngle(Y, out.root[3]).multiply(readQ(out, HIPS, _ql)).invert();
    _g.set(0, -1, 0).applyQuaternion(_qh);
    const tL = pitchOf(out, THL), tR = pitchOf(out, THR);
    const tMin = Math.min(tL, tR), tMax = Math.max(tL, tR);
    const chains = this.chains;
    for (let ci = 0; ci < chains.length; ci++) {
      const c = chains[ci];
      const K = c.K;
      _d.set(-vx, -vy, -vz).multiplyScalar(K.drag);
      if (_d.lengthSq() > 0.81) _d.setLength(0.9);
      _d.applyQuaternion(_qh).add(_g);
      let tp = Math.atan2(-_d.z, -_d.y), tr = Math.atan2(_d.x, -_d.y);
      if (c.flap === 1) tp = Math.min(tp, tMin * 0.92 - 0.06);
      else if (c.flap === 2) tp = Math.max(tp, tMax * 0.92 + 0.06);
      else tr += c.side ? 0.12 : 0.05; // sash tails hang a touch outward
      tp = tp < K.pMin ? K.pMin : tp > K.pMax ? K.pMax : tp;
      tr = tr < -K.rollMax ? -K.rollMax : tr > K.rollMax ? K.rollMax : tr;
      if (this.fresh) { c.p1 = tp; c.r1 = tr; c.p2 = 0; c.r2 = 0; c.vp1 = c.vr1 = c.vp2 = c.vr2 = 0; }
      c.pp1 = c.p1; c.pr1 = c.r1; c.pp2 = c.p2; c.pr2 = c.r2;   // previous step (render interpolation)
      c.vp1 += ((tp - c.p1) * K.k1 - c.vp1 * K.c1) * dt; c.p1 += c.vp1 * dt;
      c.vr1 += ((tr - c.r1) * K.k1 - c.vr1 * K.c1) * dt; c.r1 += c.vr1 * dt;
      c.b1.rotation.set(c.p1, 0, c.r1);
      if (c.b2) {
        // second segment trails the first: it wants to hang along the same target, relative to segment 1
        const tp2 = (tp - c.p1) * 1.3, tr2 = (tr - c.r1) * 1.3;
        c.vp2 += ((tp2 - c.p2) * K.k2 - c.vp2 * K.c2) * dt; c.p2 += c.vp2 * dt;
        c.vr2 += ((tr2 - c.r2) * K.k2 - c.vr2 * K.c2) * dt; c.r2 += c.vr2 * dt;
        if (c.p2 > 1.2) c.p2 = 1.2; else if (c.p2 < -1.2) c.p2 = -1.2;
        c.b2.rotation.set(c.p2, 0, c.r2);
      }
    }
    this.fresh = false;
  }

  /** Render-rate cloth: lerp each bone between the previous and the current sim step (alpha in [0, 1]). */
  render(a) {
    const chains = this.chains;
    for (let ci = 0; ci < chains.length; ci++) {
      const c = chains[ci];
      c.b1.rotation.set(c.pp1 + (c.p1 - c.pp1) * a, 0, c.pr1 + (c.r1 - c.pr1) * a);
      if (c.b2) c.b2.rotation.set(c.pp2 + (c.p2 - c.pp2) * a, 0, c.pr2 + (c.r2 - c.pr2) * a);
    }
  }

  /** Snap springs to rest on the next update (spawn / teleport). */
  reset() { this.fresh = true; }
}
