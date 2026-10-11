// Turntable move preview for the deck editor: a player model in its own small transparent WebGL canvas (created on
// first use, kept for reuse, rendered only while the deck editor is open). Plays one move, or a string of moves chained
// exactly like combat does (FIGHTER.md §6b): freeze the strike form for holdOut, skip the recovery, start the next move
// at chainIn with a 0.06 s blend. Fails soft (no canvas) when WebGL or the anim module is unavailable.
import * as THREE from 'three';
import { createFighterModel } from '../anim/model.js';
import { Animator } from '../anim/animator.js';
import { moveInfo } from '../combat/movedata.js';

const STEP = 1 / 120;
const CHAIN_BLEND = 0.06;

/** Timing for the preview sequencer (combat's normalised data when available). */
function timing(m) {
  try { const i = moveInfo(m); if (i) return { lastEnd: i.lastEnd, chainIn: i.chainIn, holdOut: i.holdOut, duration: i.duration }; } catch (e) { /* fallthrough */ }
  const hits = Array.isArray(m.hits) && m.hits.length ? m.hits : [{ t: m.startup || 0.2, dur: m.active || 0.06 }];
  let lastEnd = 0;
  for (const hh of hits) lastEnd = Math.max(lastEnd, (hh.t || 0) + (hh.dur || 0));
  const duration = m.duration || ((m.startup || 0.2) + (m.active || 0.06) + (m.recovery || 0.3));
  return { lastEnd, chainIn: m.chainIn ?? (m.startup || 0.2) * 0.4, holdOut: m.holdOut ?? 0.05, duration };
}

export class MovePreview {
  constructor(game) {
    this.game = game;
    this.ok = true;
    this.renderer = null;
    this.container = null;
    this.seq = [];
    this.i = 0;
    this.phase = 'idle';
    this.handle = null;
    this.holdT = 0;
    this.restT = 0;
    this.acc = 0;
    this.spin = 0;
    this.slow = 1;
    this.loco = { stance: 'FR', vx: 0, vz: 0, speed: 0, guard: false, locked: true, crouch: false };
    this.onStep = null;
  }

  _init() {
    if (this.renderer || !this.ok) return !!this.renderer;
    try {
      const r = this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.setClearColor(0x000000, 0);
      r.domElement.className = 'ls-preview-canvas';
      const scene = this.scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xfff6ea, 0x5d5650, 1.6));
      const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
      sun.position.set(-2.5, 4, 3);
      scene.add(sun);
      const rim = new THREE.DirectionalLight(0x9fe0c8, 0.9);
      rim.position.set(2, 2.5, -3);
      scene.add(rim);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.15, 48), new THREE.MeshBasicMaterial({ color: 0x0b0c0e, transparent: true, opacity: 0.45, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2;
      scene.add(disc);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.17, 64), new THREE.MeshBasicMaterial({ color: 0x5fbf9a, transparent: true, opacity: 0.55, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.002;
      scene.add(ring);
      this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
      this.model = createFighterModel({ preset: 'player' });
      scene.add(this.model.root);
      this.animator = new Animator(this.model);
      this.animator.setLocomotion(this.loco);
      this.animator.update(0);
    } catch (e) {
      console.warn('[ui] move preview unavailable:', e && e.message);
      this.ok = false;
      try { if (this.renderer) this.renderer.dispose(); } catch (err) { /* ignore */ }
      this.renderer = null;
      return false;
    }
    return true;
  }

  /** Put the canvas into `container` (an element sized by CSS). */
  attach(container) {
    this.container = container;
    if (!this._init()) return false;
    container.appendChild(this.renderer.domElement);
    this._w = this._h = 0;
    return true;
  }

  detach() {
    if (this.renderer && this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.container = null;
    this.seq = [];
    this.phase = 'idle';
  }

  /** Play a list of move objects as one chained string (one move = plain loop). */
  play(moves) {
    const list = (moves || []).filter((m) => m && m.keys && m.keys.length);
    const same = list.length === this.seq.length && list.every((m, k) => m === this.seq[k]);
    if (same && this.phase !== 'idle') return;
    this.seq = list;
    if (!this.animator) return;
    if (!list.length) { this.phase = 'idle'; this.animator.stopAction(0.15); return; }
    this._start(0.16);
  }

  _start(fade) {
    const m = this.seq[0];
    this.i = 0;
    this.loco.stance = m.start || 'FR';
    this.animator.setLocomotion(this.loco);
    this.handle = this.animator.playAction(m, { fade, startAt: 0 });
    this.phase = 'run';
    if (this.onStep) this.onStep(0, m);
  }

  _step(dt) {
    const a = this.animator;
    if (this.phase === 'run' && this.handle) {
      const m = this.seq[this.i];
      const tm = timing(m);
      const t = this.handle.time;
      if (this.i < this.seq.length - 1 && t >= tm.lastEnd) {
        a.freezeAction(tm.holdOut);
        this.holdT = tm.holdOut;
        this.phase = 'hold';
      } else if (this.handle.done || t >= tm.duration) {
        this.loco.stance = m.end || this.loco.stance;
        this.phase = 'rest';
        this.restT = this.seq.length > 1 ? 0.9 : 0.6;
      }
    } else if (this.phase === 'hold') {
      this.holdT -= dt;
      if (this.holdT <= 0) {
        this.i++;
        const m = this.seq[this.i];
        this.loco.stance = m.start || this.loco.stance;
        this.handle = a.playAction(m, { fade: CHAIN_BLEND, startAt: timing(m).chainIn });
        this.phase = 'run';
        if (this.onStep) this.onStep(this.i, m);
      }
    } else if (this.phase === 'rest') {
      this.restT -= dt;
      if (this.restT <= 0 && this.seq.length) this._start(0.22);
    }
    a.setLocomotion(this.loco);
    a.update(dt);
  }

  /** Advance (real dt) and render. */
  update(dt) {
    if (!this.renderer || !this.container || !this.animator) return;
    const c = this.container;
    const w = c.clientWidth | 0, hgt = c.clientHeight | 0;
    if (w < 8 || hgt < 8) return;
    if (w !== this._w || hgt !== this._h) {
      this._w = w; this._h = hgt;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(w, hgt, false);
      this.renderer.domElement.style.width = w + 'px';
      this.renderer.domElement.style.height = hgt + 'px';
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    this.acc += Math.min(0.1, dt) * this.slow;
    let n = 0;
    while (this.acc >= STEP && n < 12) { this._step(STEP); this.acc -= STEP; n++; }
    // gentle turntable: a three-quarter view that sways so strikes read from the side
    this.spin += dt;
    // three-quarter view from the fighter's front-left: front stances face the camera (their chest turns to the
    // lead side), strikes travel toward the opponent at screen left, and the view sways a little
    const ang = -2.3 + Math.sin(this.spin * 0.35) * 0.22;
    const dist = 4.7, tx = 0, ty = 0.98, tz = 0.3;
    this.camera.position.set(tx - Math.cos(ang) * dist, 1.38, tz - Math.sin(ang) * dist);
    this.camera.lookAt(tx, ty, tz);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.detach();
    try { if (this.model && typeof this.model.dispose === 'function') this.model.dispose(); } catch (e) { /* ignore */ }
    try { if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss(); } } catch (e) { /* ignore */ }
    this.renderer = null; this.model = null; this.animator = null;
  }
}
