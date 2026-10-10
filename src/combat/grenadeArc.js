// Grenade trajectory preview (COMBAT): while the player aims a grenade (RMB), a dotted voxel arc shows the flight
// path (same physics as the real grenade, simulated to the first impact), with a pulsing landing ring and a faint
// disc of the blast radius. Hidden automatically on any frame it is not shown.
import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { stepGrenade, GRENADE } from './projectiles.js';

const DOTS = 64;
const SIM_DT = 0.035;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class GrenadeArc {
  constructor(game) {
    this.game = game;
    this.parts = null;
    this._shownFrame = -1;
    this._s = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, inWater: false };
  }

  /** Build the meshes (lazily; also used to pre-compile their shaders). Returns {root, dots, ring, blast}. */
  ensure() {
    if (this.parts) return this.parts;
    const root = new THREE.Group();
    root.name = 'grenadeArc';
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.85, depthWrite: false, fog: false });
    const dots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), dotMat, DOTS);
    dots.frustumCulled = false;
    dots.count = 0;
    dots.renderOrder = 5;
    const ringGeo = new THREE.RingGeometry(0.42, 0.55, 20);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff6a3a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    ring.renderOrder = 5;
    const blastGeo = new THREE.RingGeometry(0.1, WEAPONS.grenade.blastRadius || 4.5, 40);
    blastGeo.rotateX(-Math.PI / 2);
    const blast = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({ color: 0xff3a1a, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    blast.renderOrder = 4;
    root.add(dots, ring, blast);
    root.visible = false;
    this.game.scene.add(root);
    this.parts = { root, dots, ring, blast };
    return this.parts;
  }

  get visible() { return !!(this.parts && this.parts.root.visible); }

  /**
   * Simulate a throw from `pos` with launch velocity `vel` and draw it for this frame.
   * Returns the landing point (Vector3, reused) or null when it does not land before the fuse runs out.
   */
  show(pos, vel) {
    const g = this.game, w = g.world;
    if (!w) return null;
    const pv = this.ensure();
    const s = this._s;
    s.pos.copy(pos); s.vel.copy(vel); s.onGround = false; s.inWater = false;
    let n = 0, landed = false;
    const cam = g.camera;
    if (cam) _cam.setFromMatrixPosition(cam.matrixWorld); else _cam.copy(pos);
    const steps = Math.ceil((WEAPONS.grenade.fuse || 2.5) / SIM_DT);
    for (let i = 0; i < steps && n < DOTS; i++) {
      const imp = stepGrenade(w, s, SIM_DT);
      if (i % 2 === 0 || imp > 0) {
        // keep the dots readable at range (roughly constant on-screen size beyond ~7 m)
        _sc.setScalar(Math.max(1, s.pos.distanceTo(_cam) / 7));
        _m.compose(s.pos, _q, _sc);
        pv.dots.setMatrixAt(n++, _m);
      }
      if (imp > 0 || s.onGround) { landed = true; break; }
    }
    pv.dots.count = n;
    pv.dots.instanceMatrix.needsUpdate = true;
    pv.ring.visible = landed;
    pv.blast.visible = landed;
    if (landed) {
      pv.ring.position.set(s.pos.x, s.pos.y - GRENADE.radius + 0.03, s.pos.z);
      pv.blast.position.copy(pv.ring.position);
      pv.ring.scale.setScalar(1 + Math.sin(g.realTime * 8) * 0.08);
    }
    pv.root.visible = true;
    this._shownFrame = g.frame;
    return landed ? s.pos : null;
  }

  /** Per-frame: hide the arc unless show() was called this frame. */
  tick() {
    if (this.parts && this.parts.root.visible && this._shownFrame !== this.game.frame) this.parts.root.visible = false;
  }
}
