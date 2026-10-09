// Ejected shell casings (COMBAT): tiny brass / red-shell voxels flung out of the ejection port, bouncing and
// tinkling on the voxel ground, fading out after a few seconds. One InstancedMesh (one draw call), fixed pool.
import * as THREE from 'three';

const CAP = 64;
const LIFE = 3.2;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const BRASS = 0xd9a93a, SHELL = 0xb3261e;

export class Casings {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this.mesh = null;
    this.items = [];
    for (let i = 0; i < CAP; i++) {
      this.items.push({ live: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), spin: new THREE.Vector3(), age: 0, scale: 1, rest: false, tink: 0 });
    }
    this._next = 0;
    this._tinkT = 0;
    this.queue = [];
  }

  _ensure() {
    if (this.mesh) return;
    const geo = new THREE.BoxGeometry(0.02, 0.02, 0.046); // a touch oversized so the brass reads on screen
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'casings';
    for (let i = 0; i < CAP; i++) this.mesh.setColorAt(i, _c.setHex(BRASS));
    this.game.scene.add(this.mesh);
  }

  /**
   * Eject one casing at `pos` (Vector3): right = unit right vector of the gun, dir = barrel direction.
   * delay > 0 queues it (pump / bolt action ejects after the shot). size scales the casing (first person: smaller).
   */
  eject(pos, right, dir, weaponId, carrierVel = null, delay = 0, size = 1) {
    const g = this.game;
    const cam = g.camera;
    if (cam && cam.position.distanceToSquared(pos) > 60 * 60) return;
    if (delay > 0) {
      if (this.queue.length < 16) this.queue.push({ t: delay, pos: pos.clone(), right: right.clone(), dir: dir.clone(), id: weaponId, vel: carrierVel ? carrierVel.clone() : null, size });
      return;
    }
    this._ensure();
    const idx = this._next;
    const it = this.items[idx];
    this._next = (this._next + 1) % CAP;
    const shotgun = weaponId === 'shotgun';
    it.live = true;
    this._spawned = true;
    it.age = 0;
    it.rest = false;
    it.tink = 0;
    it.scale = (shotgun ? 1.6 : weaponId === 'sniper' ? 1.35 : weaponId === 'pistol' ? 0.85 : 1) * size;
    it.pos.copy(pos);
    const side = 2.2 + Math.random() * 1.4;
    it.vel.copy(right).multiplyScalar(side);
    it.vel.y += 2.2 + Math.random() * 1.3;
    it.vel.addScaledVector(dir, -0.4 + Math.random() * 0.6);
    if (carrierVel) it.vel.addScaledVector(carrierVel, 0.9);
    it.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    it.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    this.mesh.setColorAt(idx, _c.setHex(shotgun ? SHELL : BRASS));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      q.t -= dt;
      if (q.t <= 0) { this.queue.splice(i, 1); this.eject(q.pos, q.right, q.dir, q.id, q.vel, 0, q.size); }
    }
    if (!this.mesh || (this.mesh.count === 0 && !this._spawned)) return;
    this._spawned = false;
    const w = this.game.world;
    let maxIdx = -1;
    this._tinkT -= dt;
    for (let i = 0; i < CAP; i++) {
      const it = this.items[i];
      if (!it.live) { if (i < this.mesh.count) { _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); } continue; }
      it.age += dt;
      if (it.age > LIFE) { it.live = false; _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); continue; }
      maxIdx = i;
      if (!it.rest) {
        it.vel.y -= 26 * dt;
        _p.copy(it.pos).addScaledVector(it.vel, dt);
        let solid = false;
        try { solid = !!(w && w.isSolid(Math.floor(_p.x), Math.floor(_p.y - 0.01), Math.floor(_p.z))); } catch (e) { solid = false; }
        if (solid) {
          // which axis did we cross? floor most of the time
          const wasAbove = !w.isSolid(Math.floor(_p.x), Math.floor(it.pos.y - 0.01), Math.floor(_p.z));
          if (wasAbove && it.vel.y < 0) {
            _p.y = Math.floor(it.pos.y - 0.01) + 0.016;
            const sp = -it.vel.y;
            it.vel.y = sp * 0.32;
            it.vel.x *= 0.55; it.vel.z *= 0.55;
            it.spin.multiplyScalar(0.6);
            if (sp > 1.5 && it.tink < 3 && this._tinkT <= 0) {
              it.tink++;
              this._tinkT = 0.04;
              this.game.audio?.play?.('empty_click', { position: _p, volume: 0.18 / it.tink, pitch: 2.1 + Math.random() * 0.5 });
            }
            if (it.vel.y < 0.6) { it.vel.set(0, 0, 0); it.rest = true; it.rot.x = Math.PI / 2 * Math.round(it.rot.x / (Math.PI / 2)); it.rot.z = 0; }
          } else {
            it.vel.x *= -0.3; it.vel.z *= -0.3;
            _p.copy(it.pos);
          }
        }
        it.pos.copy(_p);
        it.rot.addScaledVector(it.spin, dt);
      }
      const fade = it.age > LIFE - 0.5 ? Math.max(0.01, (LIFE - it.age) / 0.5) : 1;
      _q.setFromEuler(_e.set(it.rot.x, it.rot.y, it.rot.z));
      _s.setScalar(it.scale * fade);
      _m.compose(it.pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = maxIdx + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.queue.length = 0;
    for (const it of this.items) it.live = false;
    if (this.mesh) this.mesh.count = 0;
  }
}
