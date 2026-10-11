// STUB - WORLD agent. See FIGHTER.md §World.
import * as THREE from 'three';
export class World {
  constructor(game) { this.game = game; this.layout = null; }
  init() {
    const g = this.game;
    g.scene.background = new THREE.Color(0xbfd6e8);
    g.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0xd8d0c2 }));
    ground.rotation.x = -Math.PI / 2; g.scene.add(ground);
  }
  async loadChapter(id) {
    this.layout = { chapterId: id, playerStart: { x: 0, z: 0, yaw: 0 }, rooms: [{ id: 'r0', index: 0, kind: 'fight', center: { x: 0, z: 6 }, radius: 8, spawns: [{ x: 0, z: 10 }], entry: { x: 0, z: 0 } }] };
    return this.layout;
  }
  clampPosition(pos) { return pos; }
  setGate() {}
  update() {}
}
