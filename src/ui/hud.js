// STUB - to be replaced by the UI agent. See ARCHITECTURE.md §HUD.
export class HUD {
  constructor(game) { this.game = game; this.runWhenPaused = true; this.waypoint = null; }
  init() {}
  setLoading(p, text) { if (p === 0 || p === 1) console.log('[loading]', Math.round(p * 100) + '%', text || ''); }
  hideLoading() {}
  notify() {} bigMessage() {} prompt() {} setObjective() {} setTimer() {} showVehicleName() {} flashDamage() {} showArea() {}
  openPanel() {} closePanel() {}
  update() {}
}
