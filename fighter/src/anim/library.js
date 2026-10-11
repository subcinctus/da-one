// AnimLibrary (system `game.anim`): registers the stance / guard / neutral poses and every clip, and adds pose QA
// helpers to game.debug:
//   posePreview(trackOrMoveIdOrClip, times[], opts)  ghost copies posed along a row (1.2 m apart) -> one screenshot
//   lineup(opts)                                     every look side by side
//   clearPreview(), animCamera(pos, target) / animCamera(null)
import * as THREE from 'three';
import { sampleTrack, trackDuration, PoseBuffer, getPose } from './rig.js';
import { ensureAnimData, getClip as regGetClip, CLIP_NAMES, CLIPS, registerClip, LOCO } from './registry.js';
import { createFighterModel } from './model.js';
import { ClothSim } from './cloth.js';
import { LOOK_PRESETS } from './looks.js';

export { createFighterModel } from './model.js';
export { Animator } from './animator.js';

export class AnimLibrary {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this._ghosts = [];
    this._cam = null;
    this._buf = new PoseBuffer();
    /** Optional move table for posePreview by id when Combat is not up (tests can assign it). */
    this.moves = null;
  }

  init() {
    ensureAnimData();
    const g = this.game;
    if (g && g.debug) {
      g.debug.posePreview = (t, times, opts) => this.posePreview(t, times, opts);
      g.debug.lineup = (opts) => this.lineup(opts);
      g.debug.clearPreview = () => this.clearPreview();
      g.debug.animCamera = (pos, target) => this.setCamera(pos, target);
      g.debug.clipNames = () => this.clipNames();
    }
  }

  /** Track for a clip name (optionally the variant for a stance: 'hit_high' + 'BR' -> 'hit_high@BR'). */
  getClip(name, stance) { return regGetClip(name, stance); }
  /** Base clip names (stance variants excluded). */
  clipNames() { return CLIP_NAMES.slice(); }
  /** Every registered track key, including '@stance' variants. */
  allClipKeys() { return [...CLIPS.keys()]; }
  /** Add a custom clip at runtime. */
  registerClip(name, track) { return registerClip(name, track); }

  // ---------------------------------------------------------------------------------------------- debug / QA

  _resolveTrack(t, stance) {
    if (!t) return null;
    if (typeof t === 'object' && t.keys) return t;
    if (typeof t === 'string') {
      const moves = (this.game && this.game.combat && this.game.combat.MOVES) || this.moves || {};
      if (moves[t]) return moves[t];
      const c = regGetClip(t, stance);
      if (c) return c;
      const w = /^walk_(FR|FL|BR|BL)_(F|B|L|R)$/.exec(t);
      if (w && LOCO.walk) return LOCO.walk[w[1]][w[2]];
      if (t === 'run' && LOCO.run) return LOCO.run;
      const p = getPose(t);
      if (p) return { duration: 0, keys: [{ t: 0, pose: t }] };
    }
    return null;
  }

  _spawnGhost(look, x, z, yaw) {
    const m = createFighterModel(look || { preset: 'player' });
    m.root.position.set(x, 0, z);
    m.root.rotation.y = yaw || 0;
    this.game.scene.add(m.root);
    this._ghosts.push(m);
    return m;
  }

  _pose(model, track, t) {
    sampleTrack(track, t, this._buf);
    this._buf.applyTo(model.skeleton);
    model.root.updateMatrixWorld(true);
    const cloth = new ClothSim(model);
    cloth.update(1 / 120, this._buf, 0, 0, 0);
  }

  /**
   * Ghost copies of a fighter posed at `times` along a row (spacing 1.2 m) so one screenshot shows a whole motion.
   * track: move object / move id / clip name / pose name. opts: { look, stance, at: {x, z}, spacing, view: 'front' |
   * 'side' | 'quarter' | 'back', yaw (ghost facing), cam: [x, y, z] camera offset from the row centre, camTarget }.
   */
  posePreview(track, times, opts = {}) {
    this.clearPreview();
    const tr = this._resolveTrack(track, opts.stance);
    if (!tr) { console.warn('[anim] posePreview: unknown track', track); return null; }
    const dur = trackDuration(tr);
    if (!Array.isArray(times) || !times.length) {
      if (tr.startup !== undefined) {
        const s = tr.startup, a = tr.active || 0.06;
        times = [0, tr.chainIn ?? s * 0.4, s * 0.7, s, s + a * 0.5, s + a, (s + a + dur) / 2, dur];
      } else times = [0, dur * 0.15, dur * 0.3, dur * 0.45, dur * 0.6, dur * 0.8, dur];
    }
    const sp = opts.spacing || 1.2;
    const at = opts.at || this._defaultSpot();
    const n = times.length;
    const x0 = at.x - ((n - 1) * sp) / 2;
    for (let i = 0; i < n; i++) {
      const m = this._spawnGhost(opts.look, x0 + i * sp, at.z, opts.yaw || 0);
      this._pose(m, tr, Math.min(dur, Math.max(0, times[i])));
    }
    if (opts.floor !== false) this._floor(at, n * sp);
    if (opts.cam) this.setCamera({ x: at.x + opts.cam[0], y: opts.cam[1], z: at.z + opts.cam[2] }, { x: at.x + (opts.camTarget?.[0] || 0), y: opts.camTarget?.[1] ?? 1, z: at.z + (opts.camTarget?.[2] || 0) });
    else if (opts.camera !== false) this._frameRow(at, n, sp, opts.view || 'quarter');
    return { name: tr.name || tr.id || (typeof track === 'string' ? track : 'track'), duration: dur, times: times.map((t) => +t.toFixed(3)) };
  }

  /** All looks side by side (presets + a few thug seeds), posed in `opts.pose` (default 'stance:FR'). */
  lineup(opts = {}) {
    this.clearPreview();
    const looks = opts.looks || [
      ...LOOK_PRESETS.filter((p) => p !== 'thug').map((preset) => ({ preset })),
      { preset: 'thug', seed: 1 }, { preset: 'thug', seed: 2 }, { preset: 'thug', seed: 3 },
    ];
    const sp = opts.spacing || 1.2;
    const at = opts.at || this._defaultSpot();
    const n = looks.length;
    const x0 = at.x - ((n - 1) * sp) / 2;
    const track = this._resolveTrack(opts.pose || 'stance:FR', opts.stance) || { duration: 0, keys: [{ t: 0, pose: 'neutral' }] };
    looks.forEach((look, i) => {
      const m = this._spawnGhost(look, x0 + i * sp, at.z, opts.yaw || 0);
      this._pose(m, track, opts.time || 0);
    });
    if (opts.floor !== false) this._floor(at, n * sp);
    if (opts.cam) this.setCamera({ x: at.x + opts.cam[0], y: opts.cam[1], z: at.z + opts.cam[2] }, { x: at.x + (opts.camTarget?.[0] || 0), y: opts.camTarget?.[1] ?? 1, z: at.z + (opts.camTarget?.[2] || 0) });
    else if (opts.camera !== false) this._frameRow(at, n, sp, opts.view || 'front');
    return looks.map((l) => l.preset + (l.seed ? '#' + l.seed : ''));
  }

  clearPreview() {
    for (const m of this._ghosts) m.dispose();
    this._ghosts.length = 0;
    this._cam = null;
    if (this._floorMesh && this._floorMesh.parent) this._floorMesh.parent.remove(this._floorMesh);
  }

  /** Override the game camera (debug); null restores the camera rig. */
  setCamera(pos, target) {
    if (!pos) { this._cam = null; return; }
    this._cam = { pos: new THREE.Vector3(pos.x, pos.y, pos.z), target: new THREE.Vector3(target?.x || 0, target?.y ?? 1, target?.z || 0) };
  }

  /** Far from the level (no walls in the way) on a temporary studio floor. */
  _defaultSpot() { return { x: 400, z: 400 }; }

  _floor(at, width) {
    if (!this._floorMesh) {
      const geo = new THREE.CircleGeometry(1, 48);
      geo.rotateX(-Math.PI / 2);
      this._floorMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9d3c7, roughness: 1 }));
      this._floorMesh.receiveShadow = true;
      this._floorMesh.name = 'animStudioFloor';
    }
    const f = this._floorMesh;
    f.position.set(at.x, 0, at.z);
    f.scale.setScalar(Math.max(4, width * 0.75 + 2));
    if (!f.parent) this.game.scene.add(f);
  }

  _frameRow(at, n, sp, view) {
    const half = ((n - 1) * sp) / 2 + 0.8;
    const fov = (this.game.camera.fov || 55) * Math.PI / 180;
    const aspect = this.game.camera.aspect || 16 / 9;
    const dist = Math.max(3.2, (half / Math.tan(Math.atan(Math.tan(fov / 2) * aspect))) * 1.05);
    const tgt = { x: at.x, y: 0.95, z: at.z };
    let pos;
    if (view === 'side') pos = { x: at.x + dist * 0.25, y: 1.3, z: at.z + dist };
    else if (view === 'back') pos = { x: at.x, y: 1.5, z: at.z - dist };
    else if (view === 'front') pos = { x: at.x, y: 1.25, z: at.z + dist };
    else pos = { x: at.x + dist * 0.35, y: 1.6, z: at.z + dist * 0.95 };
    this.setCamera(pos, tgt);
  }

  update() {
    if (!this._cam) return;
    const c = this.game.camera;
    c.position.copy(this._cam.pos);
    c.lookAt(this._cam.target);
  }
}
