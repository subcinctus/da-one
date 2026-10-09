// STUB - to be replaced by the ATMOSPHERE agent. See ARCHITECTURE.md §Sky.
import * as THREE from 'three';
export class Sky {
  constructor(game) { this.game = game; this.time = 9; this.nightFactor = 0; this.dayLength = 1200; this.sunDir = new THREE.Vector3(0.4, 1, 0.3).normalize(); }
  init() {
    this.game.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(100, 200, 50); this.game.scene.add(sun);
  }
  update() {}
}
