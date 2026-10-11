// STUB - ANIM agent. See FIGHTER.md §Anim.
import { PoseBuffer } from './rig.js';
export class Animator {
  constructor(model) { this.model = model; this.pose = new PoseBuffer(); this.action = null; }
  setLocomotion() {}
  playAction(track, opts = {}) { this.action = { track, time: 0, duration: 0.3, done: false }; return this.action; }
  stopAction() { this.action = null; }
  update(dt) { this.pose.applyTo(this.model.skeleton); }
}
