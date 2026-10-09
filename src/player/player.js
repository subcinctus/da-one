// STUB - to be replaced by the PLAYER agent. See ARCHITECTURE.md §Player.
import * as THREE from 'three';
export class Player {
  constructor(game) {
    this.game = game; this.kind = 'player'; this.team = 'player';
    this.position = new THREE.Vector3(256.5, 28, 256.5); this.velocity = new THREE.Vector3();
    this.radius = 0.3; this.height = 1.8; this.yaw = 0; this.pitch = 0;
    this.health = 100; this.maxHealth = 100; this.armor = 0; this.alive = true; this.money = 500; this.inVehicle = null;
  }
  init() { const s = this.game.generator.plan.spawn; this.position.set(s.x, s.y, s.z); this.game.entities.add(this); }
  damage() {} addMoney(d) { this.money += d; } teleport(x, y, z) { this.position.set(x, y, z); }
  setInVehicle(v) { this.inVehicle = v; } respawn() {} heal() {} addArmor() {}
  update() {}
}
