// Blocky (voxel-style) humanoid model with procedural animation. Shared by player, pedestrians, cops, gang members.
// Proportions follow the classic 32px-tall block character. Faces +Z (see core/math.js convention).
//
//   const h = new Humanoid(randomLook());   scene.add(h.root);
//   h.root.position.copy(feetPos); h.root.rotation.y = yaw;
//   h.animate(dt, { speed, aiming, aimPitch, state, crouch });   // state: 'normal'|'dead'|'sit'|'swim'|'air'|'hands_up'
//   h.punch();  h.setHeld(meshOrNull);  h.flash();  h.dispose();
import * as THREE from 'three';
import { clamp, damp } from '../core/math.js';

export const HUMANOID_HEIGHT = 1.8;
export const HUMANOID_RADIUS = 0.3;
const PX = HUMANOID_HEIGHT / 32;

const SHARED_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true });
const FLASH_MATERIAL = new THREE.MeshBasicMaterial({ color: 0xff3333 });

const _c = new THREE.Color();

/** Box geometry (non-indexed) with a flat vertex colour, centred at (ox,oy,oz) in PX units. */
function cbox(w, h, d, color, ox = 0, oy = 0, oz = 0) {
  const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX).toNonIndexed();
  g.translate(ox * PX, oy * PX, oz * PX);
  _c.set(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  // subtle per-face shading variation baked in (top lighter, bottom darker) for a crisper voxel read
  const nrm = g.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const shade = nrm[i * 3 + 1] > 0.5 ? 1.08 : nrm[i * 3 + 1] < -0.5 ? 0.7 : Math.abs(nrm[i * 3]) > 0.5 ? 0.9 : 1.0;
    col[i * 3] = Math.min(1, _c.r * shade); col[i * 3 + 1] = Math.min(1, _c.g * shade); col[i * 3 + 2] = Math.min(1, _c.b * shade);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Merge non-indexed geometries that all have position/normal/color. */
function merge(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x6b4226, 0xd8a47f];
const HAIR = [0x2b1b0e, 0x1a1a1a, 0x4a2f1b, 0x8b5a2b, 0xd6b25e, 0x9a9a9a, 0x6e2d1c];
const SHIRT = [0xc0392b, 0x2980b9, 0x27ae60, 0xf1c40f, 0x8e44ad, 0xecf0f1, 0x34495e, 0xe67e22, 0x16a085, 0xd35400, 0x7f8c8d, 0xff6b9a];
const PANTS = [0x2c3e50, 0x1f2a44, 0x3b3b3b, 0x5d4037, 0x6d6d6d, 0x1b4f72, 0x4e342e, 0xbfae8e];
const SHOES = [0x222222, 0x3e2723, 0xeeeeee, 0x5d4037];

/** Look presets. Any field can be overridden. */
export const LOOKS = {
  player: { skin: 0xe0ac69, hair: 0x1a1a1a, shirt: 0x2e7d32, pants: 0x1f2a44, shoes: 0x222222, sleeves: false },
  cop: { skin: 0xd8a47f, hair: 0x1a1a1a, shirt: 0x1c2f5e, pants: 0x14213d, shoes: 0x111111, hat: 0x14213d, badge: 0xf1c40f, sleeves: true },
  swat: { skin: 0xc68642, hair: 0x111111, shirt: 0x222222, pants: 0x1a1a1a, shoes: 0x111111, hat: 0x1a1a1a, vest: 0x2f2f2f, sleeves: true },
  gang: { skin: 0x8d5524, hair: 0x111111, shirt: 0x6a1b9a, pants: 0x222222, shoes: 0xeeeeee, hat: 0x6a1b9a, sleeves: false },
};

/** Random civilian look. rng: () => [0,1) */
export function randomLook(rng = Math.random) {
  const p = (a) => a[Math.floor(rng() * a.length)];
  return {
    skin: p(SKIN), hair: p(HAIR), shirt: p(SHIRT), pants: p(PANTS), shoes: p(SHOES),
    sleeves: rng() < 0.5, hat: rng() < 0.15 ? p(SHIRT) : null, longHair: rng() < 0.3,
  };
}

export class Humanoid {
  constructor(look = {}) {
    const L = { ...LOOKS.player, hat: null, badge: null, vest: null, longHair: false, ...look };
    this.look = L;
    this.root = new THREE.Group();          // world placement: position = feet, rotation.y = yaw
    this.pose = new THREE.Group();          // whole-body pose (falling over etc.)
    this.root.add(this.pose);

    // --- body (12..24 px) ---
    const bodyParts = [cbox(8, 12, 4, L.shirt, 0, 18, 0)];
    if (L.vest) bodyParts.push(cbox(8.6, 8, 4.6, L.vest, 0, 19.5, 0));
    if (L.badge) bodyParts.push(cbox(1.4, 1.4, 0.4, L.badge, 2, 21, 2.15));
    this.body = new THREE.Mesh(merge(bodyParts), SHARED_MATERIAL);

    // --- head (pivot at neck 24px) ---
    const headParts = [
      cbox(8, 8, 8, L.skin, 0, 4, 0),
      cbox(8.3, 2.2, 8.3, L.hair, 0, 7.1, 0),            // hair top
      cbox(8.3, 6, 1.4, L.hair, 0, 5, -3.5),             // hair back
      cbox(1.6, 1.2, 0.3, 0xffffff, -2, 3.6, 4.05),      // eye whites
      cbox(1.6, 1.2, 0.3, 0xffffff, 2, 3.6, 4.05),
      cbox(0.8, 1.2, 0.35, 0x2b2b6b, -1.6, 3.6, 4.08),   // pupils
      cbox(0.8, 1.2, 0.35, 0x2b2b6b, 1.6, 3.6, 4.08),
      cbox(3, 0.7, 0.3, 0x8a4b3a, 0, 1.6, 4.05),         // mouth
    ];
    if (L.longHair) headParts.push(cbox(8.4, 9, 1.6, L.hair, 0, 2.5, -3.6));
    if (L.hat) {
      headParts.push(cbox(8.6, 2.4, 8.6, L.hat, 0, 8.4, 0));
      headParts.push(cbox(8.6, 0.6, 3.5, L.hat, 0, 7.4, 5.2)); // visor
    }
    this.head = new THREE.Group();
    this.head.position.y = 24 * PX;
    this.head.add(new THREE.Mesh(merge(headParts), SHARED_MATERIAL));

    // --- arms (pivot at shoulder: x=±6px, y=22px). Arm hangs from +2 to -10 px. ---
    const armGeo = (side) => merge([
      cbox(4, L.sleeves ? 9 : 4, 4, L.shirt, 0, L.sleeves ? -2.5 : 0, 0),
      cbox(3.95, L.sleeves ? 3 : 8, 3.95, L.skin, 0, L.sleeves ? -8.5 : -6, 0),
    ]);
    this.armL = new THREE.Group(); this.armL.position.set(6 * PX, 22 * PX, 0);
    this.armR = new THREE.Group(); this.armR.position.set(-6 * PX, 22 * PX, 0);
    this.armL.add(new THREE.Mesh(armGeo(1), SHARED_MATERIAL));
    this.armR.add(new THREE.Mesh(armGeo(-1), SHARED_MATERIAL));
    // hand socket for held items: item's +Z = arm's -Y (points forward when the arm is raised)
    this.hand = new THREE.Group();
    this.hand.position.set(0, -9.5 * PX, 0.5 * PX);
    this.hand.rotation.x = Math.PI / 2;
    this.armR.add(this.hand);

    // --- legs (pivot at hip: x=±2px, y=12px) ---
    const legGeo = () => merge([cbox(4, 10, 4, L.pants, 0, -5, 0), cbox(4.1, 2, 4.4, L.shoes, 0, -11, 0.2)]);
    this.legL = new THREE.Group(); this.legL.position.set(2 * PX, 12 * PX, 0);
    this.legR = new THREE.Group(); this.legR.position.set(-2 * PX, 12 * PX, 0);
    this.legL.add(new THREE.Mesh(legGeo(), SHARED_MATERIAL));
    this.legR.add(new THREE.Mesh(legGeo(), SHARED_MATERIAL));

    this.pose.add(this.body, this.head, this.armL, this.armR, this.legL, this.legR);
    this.meshes = [];
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; this.meshes.push(o); } });

    this.held = null;
    this.walkPhase = Math.random() * 10;
    this.punchT = 0;
    this.flashT = 0;
    this.deadT = 0;
  }

  /** Attach an Object3D to the right hand (built pointing along +Z), or null to clear. */
  setHeld(obj) {
    if (this.held) this.hand.remove(this.held);
    this.held = obj || null;
    if (obj) this.hand.add(obj);
  }

  punch() { this.punchT = 0.3; }

  /** Brief red flash when damaged. */
  flash() { this.flashT = 0.12; }

  /**
   * opts: speed (m/s horizontal), aiming (bool), aimPitch (rad, + = up), state ('normal'|'dead'|'sit'|'swim'|'air'|'hands_up'),
   *       crouch (bool), twoHanded (bool, default true when aiming)
   */
  animate(dt, opts = {}) {
    const speed = opts.speed || 0;
    const state = opts.state || 'normal';
    const k = damp(14, dt);
    let legL = 0, legR = 0, armL = 0, armR = 0, armLz = 0, armRz = 0, headX = 0, poseX = 0, poseY = 0, bodyLean = 0;

    if (state === 'dead') {
      this.deadT = Math.min(1, this.deadT + dt * 2.5);
      const t = this.deadT;
      poseX = -Math.PI / 2 * (t * t);
      poseY = 0.12 * t;
      armL = -0.3; armR = -0.3; armLz = 0.6; armRz = -0.6;
    } else {
      this.deadT = 0;
      if (state === 'sit') {
        legL = legR = -Math.PI / 2; armL = armR = -0.9;
      } else if (state === 'swim') {
        this.walkPhase += dt * 6;
        const s = Math.sin(this.walkPhase);
        poseX = 0.9; legL = s * 0.4; legR = -s * 0.4; armL = -2.4 + s * 0.6; armR = -2.4 - s * 0.6; headX = -0.7;
      } else if (state === 'hands_up') {
        armL = armR = -Math.PI * 0.95; armLz = 0.15; armRz = -0.15;
      } else {
        const run = clamp(speed / 7, 0, 1);
        this.walkPhase += dt * (2.2 + speed * 1.6) * (speed > 0.15 ? 1 : 0);
        const amp = speed > 0.15 ? 0.35 + 0.65 * run : 0;
        const s = Math.sin(this.walkPhase) * amp;
        legL = s * 1.1; legR = -s * 1.1;
        armL = -s * 0.9; armR = s * 0.9;
        bodyLean = run * 0.12;
        if (speed <= 0.15) { const b = Math.sin(performance.now() * 0.002) * 0.04; armLz = 0.05 + b; armRz = -0.05 - b; }
        if (state === 'air') { armL = armR = -0.5; armLz = 0.35; armRz = -0.35; legL = 0.3; legR = -0.2; }
        if (opts.crouch) { bodyLean = 0.35; legL *= 0.6; legR *= 0.6; }
      }
      if (opts.aiming) {
        const ap = clamp(opts.aimPitch || 0, -1.2, 1.2);
        armR = -Math.PI / 2 - ap; armRz = 0.0;
        if (opts.twoHanded !== false) { armL = -Math.PI / 2 - ap + 0.05; armLz = -0.45; }
        headX = -ap * 0.6;
      }
      if (this.punchT > 0) {
        this.punchT -= dt;
        const p = Math.sin(clamp(1 - this.punchT / 0.3, 0, 1) * Math.PI);
        armR = -Math.PI / 2 * p - 0.2; armRz = 0.25 * p;
      }
    }

    this.legL.rotation.x += (legL - this.legL.rotation.x) * k;
    this.legR.rotation.x += (legR - this.legR.rotation.x) * k;
    this.armL.rotation.x += (armL - this.armL.rotation.x) * k;
    this.armR.rotation.x += (armR - this.armR.rotation.x) * k;
    this.armL.rotation.z += (armLz - this.armL.rotation.z) * k;
    this.armR.rotation.z += (armRz - this.armR.rotation.z) * k;
    this.head.rotation.x += (headX - this.head.rotation.x) * k;
    if (state === 'dead') { this.pose.rotation.x = poseX; this.pose.position.y = poseY; }
    else {
      this.pose.rotation.x += ((poseX || bodyLean) - this.pose.rotation.x) * k;
      this.pose.position.y += (poseY - this.pose.position.y) * k;
    }

    if (this.flashT > 0) {
      this.flashT -= dt;
      const m = this.flashT > 0 ? FLASH_MATERIAL : SHARED_MATERIAL;
      for (const mesh of this.meshes) mesh.material = m;
    }
  }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const m of this.meshes) m.geometry.dispose();
    this.meshes.length = 0;
  }
}
