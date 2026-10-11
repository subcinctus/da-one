// CameraRig (system `cameraRig`, FIGHTER.md §10).
//
// One parametric rig drives every gameplay mode, so switching modes is always smooth:
//   pivot  P (player chest, damped)      psi  orbit yaw      phi  pitch      D  arm length    side  lateral offset
//   camera C = P - fwd(psi)·D·cos(phi) + up·D·sin(phi) + right(psi)·side
//   look   L = P + fwd(psi)·aF + right(psi)·aR + up·aY
// Unlocked: Sifu-like orbit on the right stick (sensitivity / invert settings), gentle drift behind the run.
// Locked (Absolver): camera swung behind the player's right shoulder by BETA, looking ~60% of the way to the
//   target, so the player sits left of centre and the target centre-right. Closer target = higher, tighter.
//   Target switches re-centre through the same damping.
// Spring arm: the arm shortens against room bounds + margin (world.cameraClip) and ceilings, never through walls.
// Extras: shake(amount), punch(dir), cinematic(target, duration), title orbit, debug fly / fixed pose.
// `yaw` = current view heading (forward = (sin yaw, 0, cos yaw)) for camera-relative movement.
import * as THREE from 'three';
import { damp, clamp, lerp, lerpAngle, wrapAngle, smoothstep } from '../core/math.js';
import { Shake } from './shake.js';

const FOLLOW = { D: 3.75, side: 0.42, aF: 2.2, aR: 0.42, aY: -0.12, height: 1.45 };
const LOCK = { beta: 0.52, Dmin: 3.7, Dmax: 5.2, toward: 0.6, height: 1.4 };
const YAW_RATE = 2.7;     // rad/s at full stick, sensitivity 1
const PITCH_RATE = 1.7;
const PITCH_MIN = -0.3, PITCH_MAX = 0.95;

export class CameraRig {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** Current view heading (radians). Forward on screen = (sin yaw, 0, cos yaw). */
    this.yaw = 0;
    this.pitch = 0.2;
    /** 'title' | 'follow' | 'locked' */
    this.mode = 'title';
    this.locked = false;
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(-1, 0, 0);
    this.shaker = new Shake();

    // rig state (smoothed) + targets
    this._pivot = new THREE.Vector3();
    this._psi = 0; this._phi = 0.2; this._D = FOLLOW.D; this._side = FOLLOW.side;
    this._aF = FOLLOW.aF; this._aR = FOLLOW.aR; this._aY = FOLLOW.aY;
    this._userYaw = 0; this._userPitch = 0.2;
    this._arm = 1;
    this._idle = 0;
    this._target = null;
    this._snap = true;
    this._titleA = 0.6;

    // outputs + transitions
    this._pos = new THREE.Vector3(0, 3, -5);
    this._look = new THREE.Vector3(0, 1, 0);
    this._blend = { t: 1, dur: 1, pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this._cine = { on: false, t: 0, dur: 0, out: 0.6, target: new THREE.Vector3(), track: null, from: new THREE.Vector3(), opts: null };
    this._fly = null;
    this._fixed = null;
    this._lastClass = 'title';

    // scratch
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._cp = new THREE.Vector3(); this._cl = new THREE.Vector3();
  }

  init() {
    const g = this.game;
    g.events?.on?.('worldLoaded', () => this.snap());
    g.events?.on?.('chapterStart', () => this.snap());
    const dbg = g.debug || (g.debug = {});
    /** Free-flying debug camera: WASD / left stick move, mouse / right stick look, Space up, Shift down. */
    dbg.flyCam = (on = true) => {
      if (on) this._fly = { pos: g.camera.position.clone(), yaw: this.yaw, pitch: this.pitch };
      else { this._fly = null; this.snap(); }
      return !!this._fly;
    };
    /** Fixed camera for screenshots: camPose({x,y,z}, {x,y,z}) / camPose(null). */
    dbg.camPose = (pos, look) => {
      this._fixed = pos ? { pos: new THREE.Vector3(pos.x, pos.y, pos.z), look: new THREE.Vector3(look.x, look.y, look.z) } : null;
      return !!this._fixed;
    };
    dbg.camera = () => ({ mode: this.mode, yaw: +this.yaw.toFixed(3), pitch: +this._phi.toFixed(3), D: +this._D.toFixed(2), arm: +this._arm.toFixed(2),
      pos: g.camera.position.toArray().map((v) => +v.toFixed(2)), cinematic: this._cine.on });
    this.snap();
  }

  // ------------------------------------------------------------------ public API

  /** Screen shake, amount 0..1 (respects settings.screenShake). */
  shake(amount = 0.3) {
    if (this.game.settings?.screenShake === false) return;
    this.shaker.add(amount);
  }

  /** Tiny directional kick (heavy hits). dir: Vector3-like world direction; strength ~0..1.5. */
  punch(dir, strength = 1) {
    if (this.game.settings?.screenShake === false || !dir) return;
    this.shaker.kick(dir.x || 0, (dir.y || 0) * 0.5, dir.z || 0, strength);
  }

  /**
   * Boss-intro cinematic: frame `target` (Vector3, {x,y,z}, or a Fighter to track) for `duration` real seconds,
   * then blend back to gameplay. opts: { height (look height, 1.55), distance (2.8), side (+1 right / -1 left),
   * offset (framing shift, 0.55), from ({x, z}: direction from the target toward the camera; default toward the player) }
   */
  cinematic(target, duration = 2.5, opts = null) {
    const c = this._cine;
    const pos = target?.isVector3 ? target : (target?.position || target);
    if (!pos) return;
    c.track = target && !target.isVector3 && target.position ? target : null;
    c.target.set(pos.x || 0, pos.y || 0, pos.z || 0);
    c.on = true; c.t = 0; c.dur = Math.max(0.3, duration); c.opts = opts;
    // camera approach direction: from the target toward the player (we look at the boss's face)
    const p = this._playerPos();
    if (opts?.from) c.from.set(opts.from.x, 0, opts.from.z);
    else if (p) c.from.set(p.x - c.target.x, 0, p.z - c.target.z);
    else c.from.set(0, 0, -1);
    if (c.from.lengthSq() < 1e-4) c.from.set(0, 0, -1);
    c.from.normalize();
  }

  /** End a running cinematic early (blends back). */
  endCinematic() { if (this._cine.on) { this._cine.on = false; this._startBlend(0.6); } }
  get inCinematic() { return this._cine.on; }

  /** Snap all smoothing to the current desired view (after teleports / chapter loads). */
  snap() { this._snap = true; this._blend.t = 1; this.shaker.clear(); }

  // ------------------------------------------------------------------ frame

  update(dt) {
    const g = this.game, cam = g.camera;
    dt = Math.min(dt, 0.1);
    if (this._fly) { this._updateFly(dt); return; }
    if (this._fixed) { cam.position.copy(this._fixed.pos); cam.lookAt(this._fixed.look); this._sync(cam.position, this._fixed.look); return; }
    if (g.paused) { this._write(cam); return; }

    const player = g.player;
    const playing = g.state === 'playing' && player && player.position;
    const cls = playing ? 'play' : 'title';
    if (cls !== this._lastClass) {
      // title <-> gameplay is a cut (the title orbit is in another room; a swoop would fly through walls)
      this._lastClass = cls;
      this._blend.t = 1;
      this._snap = true;
    }

    if (playing) this._updateGameplay(dt, player);
    else this._updateTitle(dt);

    // cinematic overlay
    const c = this._cine;
    if (c.on) {
      c.t += dt;
      if (c.track?.position) c.target.copy(c.track.model?.root?.position || c.track.position);
      this._cinePose(c);
      const w = smoothstep(0, 0.45, c.t);
      this._pos.lerp(this._cp, w);
      this._look.lerp(this._cl, w);
      if (c.t >= c.dur) { c.on = false; this._startBlend(0.7); }
    }
    // transition blend (mode changes, cinematic exit)
    const b = this._blend;
    if (b.t < 1) {
      b.t = Math.min(1, b.t + dt / b.dur);
      const e = b.t * b.t * (3 - 2 * b.t);
      this._pos.lerpVectors(b.pos, this._pos, e);
      this._look.lerpVectors(b.look, this._look, e);
    }
    this.shaker.update(dt);
    this._write(cam);
  }

  _startBlend(dur) {
    const b = this._blend;
    b.pos.copy(this.game.camera.position);
    // keep looking where we were looking
    this.game.camera.getWorldDirection(this._v3);
    b.look.copy(b.pos).addScaledVector(this._v3, Math.max(2, this._pos.distanceTo(this._look)));
    b.t = 0; b.dur = dur;
  }

  _write(cam) {
    cam.position.copy(this._pos);
    cam.lookAt(this._look);
    const s = this.shaker;
    if (s.trauma > 0 || s.px || s.py || s.pz) {
      cam.rotateY(s.yaw); cam.rotateX(s.pitch); cam.rotateZ(s.roll);
      cam.translateX(s.ox); cam.translateY(s.oy);
      cam.position.x += s.px; cam.position.y += s.py; cam.position.z += s.pz;
    }
    if (!this._cine.on && this._lastClass === 'play') this._sync(this._pos, this._look);
  }

  _sync(pos, look) {
    const dx = look.x - pos.x, dz = look.z - pos.z;
    if (dx * dx + dz * dz > 1e-6) this.yaw = Math.atan2(dx, dz);
    this.pitch = this._phi;
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  _playerPos() {
    const p = this.game.player;
    if (!p) return null;
    return p.model?.root?.position || p.position || null;
  }

  // ------------------------------------------------------------------ gameplay

  _updateGameplay(dt, player) {
    const g = this.game, input = g.input, s = g.settings || {};
    const P = this._playerPos();
    const tgt = player.target && player.target.alive !== false && player.target.position ? player.target : null;
    const T = tgt ? (tgt.model?.root?.position || tgt.position) : null;
    this.locked = !!T;
    this.mode = T ? 'locked' : 'follow';

    // pivot
    const px = P.x, pz = P.z, py = (P.y || 0) + (T ? LOCK.height : FOLLOW.height);
    const jump = Math.hypot(px - this._pivot.x, pz - this._pivot.z);
    if (this._snap || jump > 6) {
      this._pivot.set(px, py, pz);
      if (!T) { this._userYaw = player.yaw ?? this._userYaw; this._userPitch = 0.2; }
    } else {
      const k = damp(14, dt);
      this._pivot.x += (px - this._pivot.x) * k;
      this._pivot.y += (py - this._pivot.y) * damp(6, dt);
      this._pivot.z += (pz - this._pivot.z) * k;
    }

    // desired rig parameters
    let psi, phi, D, side, aF, aR, aY, rate;
    if (T) {
      const dx = T.x - px, dz = T.z - pz, d = Math.max(0.3, Math.hypot(dx, dz));
      const fyaw = Math.atan2(dx, dz);
      const close = clamp((2.6 - d) / 2, 0, 1);
      psi = fyaw + LOCK.beta * (1 - 0.25 * close);
      phi = 0.17 + close * 0.14;
      D = clamp(LOCK.Dmin + (d - 2) * 0.32, LOCK.Dmin, LOCK.Dmax) - close * 0.25;
      side = 0;
      // look point toward the target, expressed in the rig frame of the desired psi
      const lx = dx * LOCK.toward, lz = dz * LOCK.toward;
      const fx = Math.sin(psi), fz = Math.cos(psi);
      aF = lx * fx + lz * fz;
      aR = -lx * fz + lz * fx; // dot with right(psi) = (-cos psi, 0, sin psi)
      aY = -0.2 - close * 0.1;
      rate = 5.5;
      // keep user yaw coherent for when lock ends
      this._userYaw = lerpAngle(this._userYaw, fyaw, damp(4, dt));
      this._userPitch = phi;
      this._target = tgt;
    } else {
      // right stick orbit (ignored while the stance button is held: the stick picks a stance then)
      const lk = input?.look || { x: 0, y: 0 };
      const stanceHeld = typeof input?.down === 'function' && input.down('stance');
      const sens = s.cameraSensitivity ?? 1, inv = s.invertY ? -1 : 1;
      let lx = stanceHeld ? 0 : lk.x || 0, ly = stanceHeld ? 0 : lk.y || 0;
      this._userYaw = wrapAngle(this._userYaw - lx * YAW_RATE * sens * dt);
      this._userPitch = clamp(this._userPitch - ly * PITCH_RATE * sens * inv * dt, PITCH_MIN, PITCH_MAX);
      // gentle drift behind a running player when the stick is idle
      if (Math.abs(lx) + Math.abs(ly) > 0.05) this._idle = 0; else this._idle += dt;
      const v = player.velocity;
      const sp = v ? Math.hypot(v.x || 0, v.z || 0) : 0;
      if (this._idle > 0.8 && sp > 1.2) {
        const head = Math.atan2(v.x, v.z);
        const diff = wrapAngle(head - this._userYaw);
        if (Math.abs(diff) < 2.2) this._userYaw = wrapAngle(this._userYaw + diff * damp(0.55 * Math.min(1, sp / 4.2), dt));
        this._userPitch += (0.2 - this._userPitch) * damp(0.4, dt);
      }
      this._target = null;
      psi = this._userYaw; phi = this._userPitch;
      D = FOLLOW.D + clamp((sp - 2.8) / 1.4, 0, 1) * 0.35;
      side = FOLLOW.side; aF = FOLLOW.aF; aR = FOLLOW.aR; aY = FOLLOW.aY;
      rate = 18;
    }

    if (this._snap) {
      this._psi = psi; this._phi = phi; this._D = D; this._side = side; this._aF = aF; this._aR = aR; this._aY = aY; this._arm = 1;
      this._snap = false;
    } else {
      this._psi = lerpAngle(this._psi, psi, damp(rate, dt));
      const k = damp(T ? 4.5 : 8, dt);
      this._phi += (phi - this._phi) * damp(T ? 4 : 18, dt);
      this._D += (D - this._D) * k;
      this._side += (side - this._side) * k;
      this._aF += (aF - this._aF) * k;
      this._aR += (aR - this._aR) * k;
      this._aY += (aY - this._aY) * k;
    }
    this._compose(dt);
  }

  /** Rig parameters -> this._pos / this._look, with spring arm + ceiling. */
  _compose(dt) {
    const P = this._pivot, psi = this._psi, phi = this._phi;
    const fx = Math.sin(psi), fz = Math.cos(psi), rx = -fz, rz = fx;
    const ch = Math.cos(phi) * this._D, sh = Math.sin(phi) * this._D;
    let cx = P.x - fx * ch + rx * this._side;
    let cz = P.z - fz * ch + rz * this._side;
    let cy = P.y + sh;
    // spring arm against walls (horizontal clip from the pivot)
    const world = this.game.world;
    const t = typeof world?.cameraClip === 'function' ? world.cameraClip(P.x, P.z, cx, cz) : 1;
    if (t < this._arm) this._arm = t; else this._arm += (t - this._arm) * damp(2.5, dt);
    const a = this._arm;
    if (a < 0.999) {
      cx = P.x + (cx - P.x) * a;
      cz = P.z + (cz - P.z) * a;
      cy = P.y + (cy - P.y) * Math.max(a, 0.6) + (1 - a) * 0.9; // rise a little when squeezed
    }
    const ceil = typeof world?.ceilingAt === 'function' ? world.ceilingAt(cx, cz) : Infinity;
    cy = clamp(cy, 0.45, isFinite(ceil) ? ceil - 0.3 : 60);
    this._pos.set(cx, cy, cz);
    // squeezed arm: pull the look point back toward the pivot so the player stays in frame
    const k = this.locked ? 0.5 + 0.5 * a : 0.2 + 0.8 * a;
    this._look.set(P.x + (fx * this._aF + rx * this._aR) * k, P.y + this._aY - (1 - a) * 0.35, P.z + (fz * this._aF + rz * this._aR) * k);
  }

  // ------------------------------------------------------------------ title / cinematic / fly

  _updateTitle(dt) {
    const L = this.game.world?.layout;
    this.mode = 'title';
    this.locked = false;
    if (!L) return;
    const room = L.rooms[L.spec?.titleRoom ?? 1] || L.rooms[0];
    const hx = room.halfX ?? room.radius, hz = room.halfZ ?? room.radius;
    this._titleA += dt * 0.07;
    const a = this._titleA;
    const ceil = this.game.world?.ceilingAt?.(room.center.x, room.center.z) ?? Infinity;
    const y = Math.min(2.7, (isFinite(ceil) ? ceil : 9) - 0.6);
    this._pos.set(room.center.x + Math.sin(a) * hx * 0.88, y, room.center.z + Math.cos(a) * hz * 0.88);
    this._look.set(room.center.x - Math.sin(a) * 1.2, 1.15, room.center.z - Math.cos(a) * 1.2);
    // keep the gameplay rig primed behind the start position
    this._snap = true;
  }

  _cinePose(c) {
    const o = c.opts || {};
    const prog = clamp(c.t / c.dur, 0, 1);
    const e = 1 - (1 - prog) * (1 - prog);
    const dist = lerp((o.distance ?? 2.8) + 1.1, o.distance ?? 2.8, e);
    const side = o.side ?? 1;
    const lookH = o.height ?? 1.55;
    const fx = c.from.x, fz = c.from.z, rx = -fz, rz = fx; // right of the "from" direction
    let x = c.target.x + fx * dist + rx * side * (0.9 + 0.3 * (1 - e));
    let z = c.target.z + fz * dist + rz * side * (0.9 + 0.3 * (1 - e));
    const world = this.game.world;
    const t = typeof world?.cameraClip === 'function' ? world.cameraClip(c.target.x, c.target.z, x, z) : 1;
    x = c.target.x + (x - c.target.x) * Math.max(0.35, t);
    z = c.target.z + (z - c.target.z) * Math.max(0.35, t);
    this._cp.set(x, lerp(lookH - 0.3, lookH - 0.12, e), z);
    // look slightly to the camera's side so the subject sits on a third, not dead centre
    const off = (o.offset ?? 0.55) * side;
    this._cl.set(c.target.x + rx * off, lookH, c.target.z + rz * off);
  }

  _updateFly(dt) {
    const g = this.game, f = this._fly, input = g.input, cam = g.camera;
    const lk = input?.look || { x: 0, y: 0 }, mv = input?.move || { x: 0, y: 0 };
    f.yaw = wrapAngle(f.yaw - (lk.x || 0) * 2.2 * dt);
    f.pitch = clamp(f.pitch - (lk.y || 0) * 1.6 * dt, -1.4, 1.4);
    const sp = 6 * dt;
    const fx = Math.sin(f.yaw) * Math.cos(f.pitch), fy = -Math.sin(f.pitch), fz = Math.cos(f.yaw) * Math.cos(f.pitch);
    const rx = -Math.cos(f.yaw), rz = Math.sin(f.yaw);
    f.pos.x += (fx * (mv.y || 0) + rx * (mv.x || 0)) * sp;
    f.pos.y += fy * (mv.y || 0) * sp + ((input?.down?.('dodge') ? 1 : 0) - (input?.down?.('guard') ? 1 : 0)) * sp;
    f.pos.z += (fz * (mv.y || 0) + rz * (mv.x || 0)) * sp;
    cam.position.copy(f.pos);
    this._v1.set(f.pos.x + fx, f.pos.y + fy, f.pos.z + fz);
    cam.lookAt(this._v1);
    this.yaw = f.yaw;
  }
}
