// GhostPool: the Windfall afterimage. When a fighter starts an avoid or a dodge we snapshot its skinned pose (bone
// world matrices); if that avoid / dodge actually slips a strike, a single faint ghost of the snapshot is revealed
// where the fighter stood and fades in ~0.3 s while the real fighter has already moved. Each ghost is one skinned
// mesh sharing the fighter's geometry with frozen standalone bones: 1 draw call while visible, 0 otherwise.
import * as THREE from 'three';

const ARM_WINDOW = 0.6;   // seconds a snapshot stays revealable

class Ghost {
  constructor() {
    this.mesh = null;
    this.skeleton = null;
    this.bones = null;
    this.material = new THREE.MeshBasicMaterial({ color: 0xdcefe8, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.fighter = null;
    this.armedAt = -1e9;
    this.t = 0;
    this.life = 0.32;
    this.a0 = 0.3;
    this.active = false;
  }

  /** (Re)build the mesh for a source skinned mesh (same bone count, shared geometry). */
  _ensure(src, scene) {
    const n = src.skeleton.bones.length;
    if (!this.mesh || this.bones.length !== n) {
      if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
      if (this.skeleton) this.skeleton.dispose();
      this.bones = [];
      const inv = [];
      for (let i = 0; i < n; i++) {
        const b = new THREE.Bone();
        b.matrixAutoUpdate = false;
        b.matrixWorldAutoUpdate = false;
        this.bones.push(b);
        inv.push(new THREE.Matrix4());
      }
      this.skeleton = new THREE.Skeleton(this.bones, inv);
      this.mesh = new THREE.SkinnedMesh(src.geometry, this.material);
      this.mesh.name = 'fx-ghost';
      this.mesh.bind(this.skeleton, new THREE.Matrix4());
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = false;
      this.mesh.renderOrder = 28;
      this.mesh.matrixAutoUpdate = false;
      this.mesh.visible = false;
    }
    if (this.mesh.geometry !== src.geometry) this.mesh.geometry = src.geometry;
    if (this.mesh.parent !== scene) scene.add(this.mesh);
  }

  snapshot(f, scene, now) {
    const src = f.model && f.model.mesh;
    if (!src || !src.isSkinnedMesh || !src.skeleton) return false;
    this._ensure(src, scene);
    if (f.model.root) f.model.root.updateMatrixWorld(true);
    const sb = src.skeleton.bones, si = src.skeleton.boneInverses;
    for (let i = 0; i < this.bones.length; i++) {
      if (sb[i]) this.bones[i].matrixWorld.copy(sb[i].matrixWorld);
      if (si[i]) this.skeleton.boneInverses[i].copy(si[i]);
    }
    this.fighter = f;
    this.armedAt = now;
    this.active = false;
    this.mesh.visible = false;
    return true;
  }

  reveal(alpha, life) {
    if (!this.mesh) return false;
    this.active = true;
    this.t = 0;
    this.a0 = alpha;
    this.life = life;
    this.material.opacity = alpha;
    this.mesh.visible = true;
    return true;
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const u = this.t / this.life;
    if (u >= 1) { this.active = false; this.mesh.visible = false; this.fighter = null; this.armedAt = -1e9; return; }
    this.material.opacity = this.a0 * (1 - u) * (1 - u);
  }
}

export class GhostPool {
  constructor(count = 2) {
    this.ghosts = [];
    for (let i = 0; i < count; i++) this.ghosts.push(new Ghost());
  }

  /** Snapshot f's current pose into a free (or the oldest) ghost; hidden until reveal(). */
  arm(f, scene, now) {
    let g = null;
    for (const x of this.ghosts) if (x.fighter === f && !x.active) { g = x; break; }
    if (!g) for (const x of this.ghosts) if (!x.active && now - x.armedAt > ARM_WINDOW) { g = x; break; }
    if (!g) { g = this.ghosts[0]; for (const x of this.ghosts) if (!x.active && x.armedAt < g.armedAt) g = x; }
    if (g.active) return false;
    return g.snapshot(f, scene, now);
  }

  /** Reveal f's recent snapshot (from a successful avoid). Returns true when a ghost appeared. */
  reveal(f, now, alpha = 0.3, life = 0.32) {
    for (const g of this.ghosts) {
      if (g.fighter === f && !g.active && now - g.armedAt <= ARM_WINDOW) return g.reveal(alpha, life);
    }
    return false;
  }

  /** Snapshot + reveal at once (debug). */
  show(f, scene, now, alpha = 0.3, life = 0.32) { return this.arm(f, scene, now) && this.reveal(f, now, alpha, life); }

  get visible() { let c = 0; for (const g of this.ghosts) if (g.active) c++; return c; }

  update(dt) { for (const g of this.ghosts) g.update(dt); }

  release(f) { for (const g of this.ghosts) if (g.fighter === f) { g.fighter = null; g.active = false; g.armedAt = -1e9; if (g.mesh) g.mesh.visible = false; } }
}
