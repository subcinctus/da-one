// STUB - to be replaced by the ATMOSPHERE agent. See ARCHITECTURE.md §Audio.
export class AudioSystem {
  constructor(game) { this.game = game; this.runWhenPaused = true; }
  unlock() {}
  play() {}
  loop() { return { setVolume() {}, setPitch() {}, setPosition() {}, stop() {} }; }
  createEngine() { return { update() {}, stop() {} }; }
  update() {}
}
