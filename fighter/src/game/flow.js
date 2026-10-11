// STUB - UI agent. See FIGHTER.md §Flow.
export class Flow {
  constructor(game) { this.game = game; this.runWhenPaused = true; this.chapterId = null; this.progress = { age: 20, deaths: 0 }; }
  init() {}
  showTitle() { this.quickStart(); }
  async quickStart() { this.chapterId = 'laundromat'; await this.game.world.loadChapter('laundromat'); this.game.state = 'playing'; }
  update() {}
}
