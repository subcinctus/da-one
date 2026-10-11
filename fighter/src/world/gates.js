// Gate visuals + animation. A chapter style describes each gate as a few leaves (MeshBuilders in gate-local
// space: x along the wall, z = travel direction, y up) with an animation kind:
//   roll  : shutter rolls up into its housing (scale Y about the top)
//   slide : leaf slides along the wall by `amount` * dir (pocket screens)
//   swing : leaf swings about its hinge (local origin) by `amount` radians * dir
//   sink  : leaf sinks into the floor by `amount` metres
import * as THREE from 'three';

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class GateView {
  /**
   * @param gate  layout gate record ({ x, z, yaw, open, t, ... })
   * @param desc  { leaves: [{ builder, mat, anim, dir, amount, pivot: [x,y,z] }], openTime, closeTime }
   * @param mats  shared materials
   */
  constructor(gate, desc, mats) {
    this.gate = gate;
    this.group = new THREE.Group();
    this.group.name = 'gate:' + gate.id;
    this.group.position.set(gate.x, 0, gate.z);
    this.group.rotation.y = gate.yaw || 0;
    this.openTime = desc.openTime ?? 0.75;
    this.closeTime = desc.closeTime ?? 0.5;
    this.leaves = [];
    for (const l of desc.leaves || []) {
      if (!l.builder || l.builder.empty) continue;
      const mesh = new THREE.Mesh(l.builder.build(), mats[l.mat || 'matte'] || mats.matte);
      mesh.castShadow = l.mat !== 'glass';
      mesh.receiveShadow = l.mat !== 'glass';
      const p = l.pivot || [0, 0, 0];
      mesh.position.set(p[0], p[1], p[2]);
      mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      this.leaves.push({ mesh, anim: l.anim || 'sink', dir: l.dir ?? 1, amount: l.amount ?? 1, base: p.slice() });
    }
    this._applied = -1;
    this.apply();
  }

  /** Advance the animation (real seconds). Returns true while moving. */
  step(dt) {
    const g = this.gate;
    const target = g.open ? 1 : 0;
    if (g.t !== target) {
      const rate = 1 / (g.open ? this.openTime : this.closeTime);
      g.t = g.open ? Math.min(1, g.t + dt * rate) : Math.max(0, g.t - dt * rate);
    }
    this.apply();
    return g.t !== target;
  }

  apply() {
    const t = this.gate.t;
    if (t === this._applied) return;
    this._applied = t;
    const e = easeInOut(t);
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i], m = l.mesh;
      switch (l.anim) {
        case 'roll': m.scale.y = Math.max(0.04, 1 - e * 0.96); break;
        case 'slide': m.position.x = l.base[0] + l.dir * l.amount * e; break;
        case 'swing': m.rotation.y = l.dir * l.amount * e; break;
        default: m.position.y = l.base[1] - l.amount * e; m.visible = e < 0.999; break;
      }
    }
  }

  dispose() {
    for (const l of this.leaves) l.mesh.geometry.dispose();
    this.group.removeFromParent();
  }
}
