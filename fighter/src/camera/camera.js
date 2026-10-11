// STUB - WORLD agent. See FIGHTER.md §Camera.
export class CameraRig {
  constructor(game) { this.game = game; this.yaw = 0; }
  init() {}
  shake() {}
  update() { const p = this.game.player, c = this.game.camera; const x = p ? p.position.x : 0, z = p ? p.position.z : 0; c.position.set(x, 2.2, z - 5); c.lookAt(x, 1.2, z + 2); }
}
