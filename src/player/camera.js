// STUB - to be replaced by the PLAYER agent. See ARCHITECTURE.md §CameraRig.
import * as THREE from 'three';
export class CameraRig {
  constructor(game) { this.game = game; this.mode = 'third'; this.yaw = 0; this.pitch = -0.2; }
  init() {}
  getAimRay() { const c = this.game.camera; const d = new THREE.Vector3(); c.getWorldDirection(d); return { origin: c.position.clone(), dir: d }; }
  shake() {}
  update() {
    const p = this.game.player.position, c = this.game.camera;
    c.position.set(p.x, p.y + 6, p.z - 9); c.lookAt(p.x, p.y + 1.6, p.z);
  }
}
