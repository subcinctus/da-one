// PlayerController: turns game.input into the player Fighter's intent each sim step.
//   Movement is camera-relative (derived from the real camera, falling back to cameraRig.yaw); with lock-on the
//   fighter strafes around its target. LB toggles lock-on to the best enemy in front within 12 m, RS click / a right
//   stick flick (pad: stick from centre past |x| 0.85 with the stance button up) cycles targets, and a dead target
//   hands the lock to the next nearest.
import * as THREE from 'three';
import { angleDiff, yawTo } from '../core/math.js';
import { T } from './constants.js';

const _dir = new THREE.Vector3();

export class PlayerController {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    /** Locked Fighter or null. */
    this.lockTarget = null;
    this._flickArmed = true;
    this.pendingStance = null;
    this._c = this._consume.bind(this);
  }

  reset() { this.lockTarget = null; this._flickArmed = true; this.pendingStance = null; }

  /** Buffered press (input.consume) — a bound method so the per-step update allocates nothing. */
  _consume(action, window) {
    const inp = this.game.input;
    return !!inp && typeof inp.consume === 'function' && inp.consume(action, window);
  }

  /** Camera yaw in the fighter convention (forward = (sin, 0, cos)). */
  cameraYaw() {
    const g = this.game;
    const cam = g.camera;
    if (cam && typeof cam.getWorldDirection === 'function') {
      cam.getWorldDirection(_dir);
      if (_dir.x * _dir.x + _dir.z * _dir.z > 1e-4) return Math.atan2(_dir.x, _dir.z);
    }
    const y = g.cameraRig && g.cameraRig.yaw;
    return typeof y === 'number' && isFinite(y) ? y : 0;
  }

  /** Write `f.intent` from the input devices. */
  update(dt, f) {
    const g = this.game;
    const inp = g.input;
    const it = f.intent;
    if (!inp) return;
    // ---- movement (camera relative)
    const camYaw = this.cameraYaw();
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    let mx = inp.move ? inp.move.x : 0, my = inp.move ? inp.move.y : 0;
    const stanceHeld = typeof inp.down === 'function' && inp.down('stance');
    if (stanceHeld && !inp.padType) { mx = 0; my = 0; }   // keyboard: R + WASD picks a stance instead of walking
    // world = forward * y + right * x, right = (-cos, 0, sin)
    it.moveX = fx * my + -fz * mx;
    it.moveZ = fz * my + fx * mx;

    // ---- actions (buffered presses; the Fighter keeps its own 0.2 s buffer / string queue)
    const c = this._c;
    if (c('light', T.BUFFER)) it.light = true;
    if (c('heavy', T.BUFFER)) it.heavy = true;
    it.guard = typeof inp.down === 'function' && inp.down('guard');
    if (c('guard', 0.12)) it.feint = true;
    if (c('dodge', T.BUFFER)) { it.dodge = true; it.dodgeDir.x = it.moveX; it.dodgeDir.z = it.moveZ; }
    if (c('defend', T.BUFFER)) it.defend = true;
    if (c('focus', T.BUFFER)) it.focus = true;
    it.charge = typeof inp.down === 'function' && (inp.down('light') || inp.down('heavy'));
    const flick = typeof inp.stanceFlick === 'function' ? inp.stanceFlick() : null;
    if (flick) it.stance = flick;
    else if (this.pendingStance) it.stance = this.pendingStance;
    this.pendingStance = null;

    // ---- lock-on
    let t = this.lockTarget;
    if (t && (!t.alive || t.removed)) t = this.lockTarget = this._pickNearest(f, t);
    if (t && dist2(f, t) > (T.LOCK_RANGE * 1.6) ** 2) t = this.lockTarget = null;   // walked far away: release
    if (c('lock', 0.2)) {
      if (t) t = this.lockTarget = null;
      else t = this.lockTarget = this._pickBest(f, camYaw);
    }
    if (c('target', 0.2)) {
      if (t) t = this.lockTarget = this._cycle(f, t, camYaw, -1, true) || t;
      else t = this.lockTarget = this._pickBest(f, camYaw);
    }
    // right-stick flick (pad only) cycles left / right. Arming is tracked every step, locked or not: holding the stance
    // button disarms it, and only a stick back near centre with RT up re-arms it. So letting go of RT a few frames
    // before the stick re-centres (the natural end of a stance flick) never reads as a target flick, and a stick that
    // was already deflected (camera steering) when the lock came on does not cycle either.
    if (inp.padType && inp.look) {
      const lx = Math.abs(inp.look.x) || 0;
      if (stanceHeld) this._flickArmed = false;
      else if (lx < 0.4) this._flickArmed = true;
      else if (this._flickArmed && lx > 0.85) {
        this._flickArmed = false;
        if (t) t = this.lockTarget = this._cycle(f, t, camYaw, inp.look.x > 0 ? -1 : 1, false) || t;
      }
    }
    it.lockTarget = t;
  }

  /**
   * Best enemy in front of the camera within LOCK_RANGE (distance weighted by angle). When nobody is in the camera's
   * cone, the nearest enemy in range is taken instead: pressing lock should never do nothing with enemies around.
   */
  _pickBest(f, camYaw) {
    let best = null, bestScore = Infinity;
    for (const e of this.combat.fighters) {
      if (e === f || e.team === f.team || !e.alive || e.removed) continue;
      const d = Math.sqrt(dist2(f, e));
      if (d > T.LOCK_RANGE) continue;
      const ang = Math.abs(angleDiff(camYaw, yawTo(f.position.x, f.position.z, e.position.x, e.position.z)));
      const inCone = ang <= T.LOCK_ARC || d <= 2.5;
      const score = d * (1 + ang * 1.2) + (inCone ? 0 : 1000);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  _pickNearest(f, except) {
    let best = null, bd = T.LOCK_RANGE * T.LOCK_RANGE;
    for (const e of this.combat.fighters) {
      if (e === f || e === except || e.team === f.team || !e.alive || e.removed) continue;
      const d = dist2(f, e);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /**
   * Next target to one side of the current one (bearing relative to the camera). side -1 = to the right,
   * +1 = to the left (turning left increases yaw). wrap: jump to the far end when nothing lies on that side.
   */
  _cycle(f, cur, camYaw, side, wrap) {
    const bearing = (e) => angleDiff(camYaw, yawTo(f.position.x, f.position.z, e.position.x, e.position.z));
    const bc = bearing(cur);
    let best = null, bestD = Infinity, far = null, farB = 0;
    for (const e of this.combat.fighters) {
      if (e === f || e === cur || e.team === f.team || !e.alive || e.removed) continue;
      if (dist2(f, e) > T.LOCK_RANGE * T.LOCK_RANGE) continue;
      const b = bearing(e);
      const delta = (b - bc) * side;   // > 0 means on the requested side
      if (delta > 0 && delta < bestD) { bestD = delta; best = e; }
      // wrap candidate: the most extreme one on the OTHER side
      if (delta < 0 && (far === null || delta < farB)) { farB = delta; far = e; }
    }
    return best || (wrap ? far : null);
  }
}

function dist2(a, b) {
  const dx = a.position.x - b.position.x, dz = a.position.z - b.position.z;
  return dx * dx + dz * dz;
}
