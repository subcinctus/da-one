// STUB - UI agent. See FIGHTER.md §HUD.
export class HUD {
  constructor(game) { this.game = game; this.runWhenPaused = true; }
  init() {}
  setLoading(p, t) { if (p === 0 || p === 1) console.log('[loading]', Math.round(p * 100) + '%', t || ''); }
  hideLoading() {}
  update() {}
}
