// First-person view model: the held item (arm / block / tool / weapon) at the bottom-right of the view.
// Attached to game.camera. Rendered in the transparent pass with renderOrder > 1000 right after a depth clear,
// so it never clips into walls and still self-occludes correctly. Walk bob, look sway, swing, recoil kick,
// equip animation, sprint pose and aim-down-sights pose.
import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/math.js';
import { WEAPONS } from '../data/weapons.js';
import { itemKey } from '../data/items.js';
import { LOOKS } from '../entities/humanoid.js';
import { ItemModels, armGeometry, handGeometry, VM_RENDER_ORDER } from './models.js';

// Base poses in camera space (camera looks down -Z, +X right, +Y up). Angles in radians.
const POSES = {
  hand:   { x: 0.33, y: -0.36, z: -0.38, rx: 0.42, ry: 0.32, rz: 0.12 },
  block:  { x: 0.3, y: -0.28, z: -0.52, rx: 0.16, ry: 0.72, rz: 0.0, s: 0.15 },
  plant:  { x: 0.3, y: -0.25, z: -0.5, rx: 0.0, ry: 0.4, rz: 0.0, s: 0.22 },
  tool:   { x: 0.31, y: -0.43, z: -0.5, rx: -0.55, ry: -0.35, rz: 0.42, s: 0.72 },
  weapon: { x: 0.2, y: -0.2, z: -0.44, rx: 0.0, ry: 0.0, rz: 0.0 },
  ads:    { x: 0.0, y: -0.06, z: -0.42, rx: 0.0, ry: 0.0, rz: 0.0 },
};

/** Target longest dimension (m) of weapon models in first person, by id. */
const WEAPON_LEN = { pistol: 0.3, smg: 0.46, shotgun: 0.72, rifle: 0.72, sniper: 0.82, rpg: 0.9, bat: 0.78, grenade: 0.12 };

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _ctr = new THREE.Vector3();

const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

export class ViewModel {
  constructor(game, rig) {
    this.game = game;
    this.rig = rig;
    this.models = new ItemModels(game);
    this.root = new THREE.Group();
    this.root.name = 'viewModel';
    this.root.visible = false;
    this.anchor = new THREE.Group();     // animated transform for the current pose
    this.root.add(this.anchor);

    const look = LOOKS.player;
    // own material (constructors must not reach into other systems; ItemModels.mat reads the world atlas)
    const armMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthTest: true, depthWrite: true, fog: false });
    this.arm = new THREE.Mesh(armGeometry(look), armMat);
    this.hand = new THREE.Mesh(handGeometry(look), armMat);
    for (const m of [this.arm, this.hand]) { m.renderOrder = VM_RENDER_ORDER; m.frustumCulled = false; }

    // depth clear right before the view model draws (first item of the transparent pass at renderOrder 1000)
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.3, 0.0001, 0, -0.3, 0, 0.0001, -0.3], 3));
    const cm = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true, fog: false });
    this.clearer = new THREE.Mesh(cg, cm);
    this.clearer.renderOrder = VM_RENDER_ORDER - 1;
    this.clearer.frustumCulled = false;
    this.clearer.onBeforeRender = (renderer) => {
      try { renderer.state.buffers.depth.setMask(true); renderer.clearDepth(); } catch (e) { /* ignore */ }
    };
    this.root.add(this.clearer);

    this.itemKey = null;
    this.item = null;
    this.current = null;     // Object3D of the held item
    this.kind = 'hand';
    this.pose = POSES.hand;

    this.swingT = 1;         // 0..1 progress of the swing animation (1 = idle)
    this.swingDur = 0.27;
    this.equipT = 1;
    this.kick = 0;
    this.aimT = 0;
    this.sprintT = 0;
    this.bobAmp = 0;
    this.swayX = 0; this.swayY = 0;
    this._lastYaw = 0; this._lastPitch = 0;
    this._t = 0;
    this._attached = false;
  }

  attach() {
    if (this._attached || !this.game.camera) return;
    this.game.camera.add(this.root);
    this._attached = true;
  }

  /** Start a swing (mine / place / punch). Restarts if already more than half done. */
  swing() {
    if (this.swingT >= 0.5) this.swingT = 0;
  }

  /** Recoil kick (weapon fired). */
  fireKick(amount = 1) {
    this.kick = Math.min(1.4, this.kick + amount);
  }

  /** Change the displayed item (null = empty hand). */
  setItem(item) {
    const key = itemKey(item);
    if (key === this.itemKey) { this.item = item; return; }
    this.itemKey = key;
    this.item = item;
    if (this.current) this.anchor.remove(this.current);
    if (this.arm.parent) this.anchor.remove(this.arm);
    if (this.hand.parent) this.anchor.remove(this.hand);
    this.current = null;
    if (!item) {
      this.kind = 'hand';
      this.pose = POSES.hand;
      this.anchor.add(this.arm);
    } else {
      const obj = this.models.get(item, 'vm');
      this.current = obj;
      if (item.kind === 'block') {
        const cross = obj && obj.userData.cross;
        this.kind = 'block';
        this.pose = cross ? POSES.plant : POSES.block;
        if (obj) obj.scale.setScalar(this.pose.s);
      } else if (item.kind === 'tool') {
        this.kind = 'tool';
        this.pose = POSES.tool;
        if (obj) obj.scale.setScalar(this.pose.s);
      } else {
        this.kind = 'weapon';
        this.pose = POSES.weapon;
        if (obj) this._normalizeWeapon(obj, item.id);
        this.anchor.add(this.hand);
        this.hand.position.set(0.0, -0.085, 0.1);
        this.hand.rotation.set(0.25, 0, 0);
      }
      if (obj) this.anchor.add(obj);
    }
    this.equipT = 0;
  }

  /** Fit an arbitrary weapon model into first person: barrel to -Z, longest side = WEAPON_LEN, centred. */
  _normalizeWeapon(obj, id) {
    if (obj.userData.vmNormalized) return;
    const inner = obj.children[0];
    if (!inner) return;
    // measure in the wrapper's frame (wrapper is detached with an identity transform at this point)
    obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.set(1, 1, 1);
    obj.updateMatrixWorld(true);
    _box.setFromObject(inner);
    if (_box.isEmpty()) return;
    _box.getSize(_size); _box.getCenter(_ctr);
    const longest = Math.max(_size.x, _size.y, _size.z, 1e-3);
    const s = (WEAPON_LEN[id] || 0.5) / longest;
    // scale about the wrapper origin and move the bbox centre onto it (keeps Combat's own internal orientation)
    inner.position.sub(_ctr).multiplyScalar(s);
    inner.scale.multiplyScalar(s);
    obj.userData.vmHalfH = _size.y * s * 0.5;
    obj.rotation.y = Math.PI; // models point +Z; the camera looks down -Z
    obj.userData.vmNormalized = true;
    obj.userData.vmLen = WEAPON_LEN[id] || 0.5;
  }

  /**
   * ctx: { visible, speed (m/s horizontal), walkDist, onGround, sprinting, aiming, dip (camera landing offset) }
   */
  update(dt, ctx) {
    this.attach();
    const vis = !!ctx.visible;
    this.root.visible = vis;
    // look sway: from the rig's yaw/pitch change rate
    const dyaw = this._wrap(this.rig.yaw - this._lastYaw), dpitch = this.rig.pitch - this._lastPitch;
    this._lastYaw = this.rig.yaw; this._lastPitch = this.rig.pitch;
    if (!vis) { this.swingT = 1; this.kick = 0; return; }
    this._t += dt;

    const kD = damp(10, dt);
    const sx = clamp(dyaw * 0.9, -0.06, 0.06), sy = clamp(-dpitch * 0.9, -0.05, 0.05);
    this.swayX += (sx - this.swayX) * kD;
    this.swayY += (sy - this.swayY) * kD;

    const isWeapon = this.kind === 'weapon';
    const def = isWeapon && this.item ? WEAPONS[this.item.id] : null;
    const gun = def && (def.kind === 'hitscan' || def.kind === 'projectile');
    this.aimT += ((ctx.aiming && gun ? 1 : 0) - this.aimT) * damp(14, dt);
    this.sprintT += ((ctx.sprinting && ctx.onGround && !ctx.aiming && this.swingT >= 1 ? 1 : 0) - this.sprintT) * damp(8, dt);
    const targetAmp = ctx.onGround ? clamp(ctx.speed / 4.3, 0, 1.75) : 0;
    this.bobAmp += (targetAmp - this.bobAmp) * damp(8, dt);

    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt / this.swingDur);
    if (this.equipT < 1) this.equipT = Math.min(1, this.equipT + dt / 0.22);
    this.kick *= Math.exp(-13 * dt);

    const P = this.pose;
    let px = P.x, py = P.y, pz = P.z, rx = P.rx, ry = P.ry, rz = P.rz;
    if (gun && this.aimT > 0.001) {
      const A = POSES.ads, t = this.aimT;
      // sights: the top of the weapon sits just under the crosshair
      const ay = this.current && this.current.userData.vmHalfH ? -this.current.userData.vmHalfH - 0.012 : A.y;
      px = lerp(px, A.x, t); py = lerp(py, ay, t); pz = lerp(pz, A.z, t);
      rx = lerp(rx, A.rx, t); ry = lerp(ry, A.ry, t); rz = lerp(rz, A.rz, t);
    }
    // equip: rise from below
    const e = easeOut(this.equipT);
    py -= (1 - e) * 0.38; rx -= (1 - e) * 0.8;
    // walk bob (reduced while aiming)
    const bobScale = 1 - this.aimT * 0.75;
    const ph = (ctx.walkDist || 0) * Math.PI / 1.9;
    const amp = this.bobAmp * bobScale;
    px += Math.sin(ph) * 0.02 * amp;
    py += (0.012 - Math.abs(Math.cos(ph)) * 0.026) * amp;
    rz += Math.sin(ph) * 0.025 * amp;
    // breathing idle
    py += Math.sin(this._t * 1.7) * 0.0045 * bobScale;
    px += Math.sin(this._t * 0.9) * 0.002 * bobScale;
    // sway (lag behind the look direction)
    px -= this.swayX * 0.6 * bobScale; py -= this.swayY * 0.6 * bobScale;
    ry += this.swayX * 1.2 * bobScale; rx += this.swayY * 0.8 * bobScale;
    // sprint pose
    const sp = this.sprintT;
    if (sp > 0.001) {
      if (isWeapon) { rx -= 0.5 * sp; ry += 0.55 * sp; px -= 0.04 * sp; py -= 0.05 * sp; }
      else { rx -= 0.18 * sp; py -= 0.03 * sp; }
    }
    // swing (Minecraft-like arc)
    if (this.swingT < 1) {
      const t = this.swingT, s1 = Math.sin(t * Math.PI), s2 = Math.sin(Math.sqrt(t) * Math.PI);
      if (this.kind === 'tool' || (isWeapon && def && def.kind === 'melee')) {
        // chop: rotate down and toward the centre
        px -= 0.1 * s2; py += 0.05 * Math.sin(Math.sqrt(t) * Math.PI * 2); pz -= 0.1 * s1;
        rx -= 1.0 * s2; rz += 0.25 * s2; ry += 0.3 * Math.sin(t * t * Math.PI);
      } else if (isWeapon) {
        // throw / bash
        pz -= 0.12 * s1; py += 0.06 * s2; rx += 0.6 * s2;
      } else {
        // punch / place
        px -= 0.17 * s2; py += 0.09 * Math.sin(Math.sqrt(t) * Math.PI * 2); pz -= 0.16 * s1;
        rx += 0.35 * s2; ry += 0.55 * Math.sin(t * t * Math.PI); rz -= 0.3 * s2;
      }
    }
    // recoil
    const k = this.kick;
    pz += k * (0.09 - this.aimT * 0.04); rx += k * (0.32 - this.aimT * 0.18); py += k * 0.012;
    // landing dip from the camera
    py += (ctx.dip || 0) * 0.5;

    this.anchor.position.set(px, py, pz);
    this.anchor.rotation.set(rx, ry, rz);
  }

  _wrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
}
