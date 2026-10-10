// CameraRig: third-person over-the-shoulder (GTA V style), first-person (Minecraft style), far cam, aim cam,
// vehicle chase / far / hood cams, title-screen orbit, death cam. Voxel collision, damped smoothing,
// trauma shake, recoil with recovery, FOV kicks. Owns the first-person view model. See ARCHITECTURE.md §CameraRig.
import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle, angleDiff, dirFromYawPitch, rightFromYaw, forwardFromYaw, smoothstep } from '../core/math.js';
import { voxelRaycast } from '../core/physics.js';
import { WEAPONS } from '../data/weapons.js';
import { BLOCKS } from '../world/blocks.js';
import { ViewModel } from './viewmodel.js';
import { CAM } from './tuning.js';

const MODES = ['third', 'first', 'far'];
const VEHICLE_MODES = ['chase', 'far', 'hood'];
const PITCH_LIMIT = (85 * Math.PI) / 180;

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _eyeP = new THREE.Vector3();
const _dbPivot = new THREE.Vector3();
const _dbPos = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Smooth pseudo-noise in [-1, 1] (sum of incommensurate sines). */
function wobble(t) {
  return Math.sin(t) * 0.5 + Math.sin(t * 2.31 + 1.7) * 0.3 + Math.sin(t * 5.13 + 3.1) * 0.2;
}

export class CameraRig {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** on-foot mode: 'third' | 'first' | 'far' */
    this.mode = 'third';
    /** in-vehicle mode: 'chase' | 'far' | 'hood' */
    this.vehicleMode = 'chase';
    /** view yaw / pitch (radians). The player walks relative to this yaw. */
    this.yaw = 0;
    this.pitch = -0.12;
    /** true while the shoulder aim cam is active */
    this.aiming = false;
    /** true when the view is currently first-person (mode first, hood cam or a scoped weapon) */
    this.firstPerson = false;
    /** set true by anything that wants the mouse wheel (inventory skips slot cycling) */
    this.wantsWheel = false;

    this.trauma = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.fov = 75;
    this.dip = 0;          // landing dip offset (m, negative = down)
    this._dipV = 0;

    this._aimT = 0;
    this._dist = CAM.third.dist;
    this._off = CAM.third.offset;
    this._height = CAM.third.height;
    this._colDist = CAM.third.dist;
    this._pivot = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._snap = true;
    this._lastLookTime = -100;
    this._vehPivotY = 0;
    this._vehDist = 7;
    this._deathT = 0;
    this._deathAngle = 0;
    this._wasState = null;
    this._lastVehicle = null;
    this.scoped = false;
    this._camTooClose = false;
    this._snapVehicle = false;
    // tight spaces (tunnels, lobbies, back to a wall): third person switches to the first-person eye
    this.cramped = false;
    this._crampK = 0;        // 0..1 camera blend third -> eye
    this._crampHold = 0;     // s left before the cramped state may change again
    // drive-by aiming framing (over the roof, out of the aim-side window)
    this._dbT = 0;
    this._dbSide = 0;
    this._dbSideS = 0;
    this._dbDist = 2.6;
    this.viewModel = new ViewModel(game, this);
    this._ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
  }

  init() {
    const g = this.game;
    this.fov = g.settings.fov || 75;
    const spawn = g.generator && g.generator.plan && g.generator.plan.spawn;
    if (spawn && Number.isFinite(spawn.yaw)) this.yaw = spawn.yaw;
    this.viewModel.attach();
    const ev = g.events;
    ev.on('playerRespawned', () => { const p = g.player; if (p) this.yaw = p.yaw; this.pitch = -0.12; this.recoilPitch = this.recoilYaw = 0; this.trauma = 0; this.snap(); });
    ev.on('weaponFired', (e) => {
      if (!e || !e.byPlayer) return;
      const def = WEAPONS[e.weapon] || WEAPONS[e.weapon && e.weapon.id];
      if (def && (def.kind === 'melee' || def.kind === 'throw')) this.viewModel.swing();
      else this.viewModel.fireKick(def && def.id === 'shotgun' ? 1.3 : def && (def.id === 'sniper' || def.id === 'rpg') ? 1.4 : 0.75);
    });
    ev.on('vehicleEnter', (e) => { if (e && e.character === g.player) { this._lastLookTime = -100; this._snapVehicle = true; } });
    ev.on('vehicleExit', (e) => { if (e && e.character === g.player) this._snap = true; });
    ev.on('settingsChanged', (s) => { if (s && s.fov) this.fov = s.fov; });
  }

  // ------------------------------------------------------------------ public API

  /** Camera-centre ray in world space: {origin, dir}. Pass `out` to avoid allocation. */
  getAimRay(out) {
    const c = this.game.camera;
    const r = out || { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
    if (!r.origin) r.origin = new THREE.Vector3();
    if (!r.dir) r.dir = new THREE.Vector3();
    c.updateMatrixWorld();
    r.origin.setFromMatrixPosition(c.matrixWorld);
    r.dir.set(0, 0, -1).transformDirection(c.matrixWorld);
    return r;
  }

  /** Add camera shake (trauma 0..1, squared falloff). */
  shake(intensity = 0.3) {
    if (!(intensity > 0)) return;
    this.trauma = Math.min(1, this.trauma + intensity);
  }

  /** Weapon recoil: kicks the view (pitch up = positive) and mostly recovers. */
  addRecoil(pitchRad = 0, yawRad = 0) {
    // 35% sticks to the aim (sustained fire climbs), 65% is a visual kick that recovers
    this.pitch = clamp(this.pitch + pitchRad * 0.35, -PITCH_LIMIT, PITCH_LIMIT);
    this.yaw = wrapAngle(this.yaw + yawRad * 0.35);
    this.recoilPitch += pitchRad * 0.65;
    this.recoilYaw += yawRad * 0.65;
  }

  /** Landing impact (0..1): camera dips and springs back. */
  landKick(amount) {
    this._dipV -= clamp(amount, 0, 1) * 2.6;
  }

  /** Next update jumps straight to the target (no smoothing). */
  snap() { this._snap = true; }

  setMode(m) { if (MODES.includes(m)) { this.mode = m; this._snap = true; } }

  cycleMode() {
    const p = this.game.player;
    if (p && p.inVehicle) {
      this.vehicleMode = VEHICLE_MODES[(VEHICLE_MODES.indexOf(this.vehicleMode) + 1) % VEHICLE_MODES.length];
    } else {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    }
    this.game.audio?.play?.('ui_click', { volume: 0.25 });
  }

  /** True when the view is first person right now. */
  isFirstPerson() { return this.firstPerson; }

  // ------------------------------------------------------------------ update

  update(dt) {
    const g = this.game;
    const cam = g.camera;
    if (!cam) return;
    if (g.state !== 'playing') {
      this._wasState = g.state;
      this._titleOrbit(dt);
      return;
    }
    if (this._wasState !== 'playing') { this._wasState = 'playing'; this._snap = true; }
    if (!g.running) return; // paused / UI open: freeze

    const p = g.player;
    if (!p || !p.position) return;

    // ---- look input
    const look = g.input.lookRadians();
    const zoom = this._currentZoom(p);
    // slower look while zoomed (by the zoom actually applied: partial over the shoulder, full in first person)
    const effZoom = this.mode === 'first' || zoom >= 3 ? zoom : 1 + (zoom - 1) * CAM.thirdPersonZoom;
    const sensScale = effZoom > 1 ? 1 / Math.pow(effZoom, 0.85) : 1;
    if (look.yaw !== 0 || look.pitch !== 0) {
      this._lastLookTime = g.realTime;
      if (p.alive) {
        this.yaw = wrapAngle(this.yaw + look.yaw * sensScale);
        this.pitch = clamp(this.pitch + look.pitch * sensScale, -PITCH_LIMIT, PITCH_LIMIT);
      }
    }
    if (g.input.pressed('camera') && p.alive) this.cycleMode();

    // ---- recoil recovery, shake decay, landing dip spring
    const kr = Math.exp(-9 * dt);
    this.recoilPitch *= kr; this.recoilYaw *= kr;
    this.trauma = Math.max(0, this.trauma - dt * 1.15);
    const acc = -55 * this.dip - 11 * this._dipV;
    this._dipV += acc * dt; this.dip += this._dipV * dt;
    if (Math.abs(this.dip) < 1e-4 && Math.abs(this._dipV) < 1e-3) { this.dip = 0; this._dipV = 0; }

    let fovTarget = g.settings.fov || 75;
    this.firstPerson = false;
    this.aiming = false;
    this.scoped = false;
    this._camTooClose = false;

    if (!p.alive || p.inVehicle) { this.cramped = false; this._crampK = 0; this._crampHold = 0; }
    if (!(p.alive && p.inVehicle)) this._dbT = 0;
    if (!p.alive) {
      this._deathCam(dt, p);
    } else if (p.inVehicle) {
      this._deathT = 0;
      fovTarget += this._vehicleCam(dt, p, p.inVehicle);
    } else {
      this._deathT = 0;
      fovTarget = this._footCam(dt, p, fovTarget, zoom);
    }
    this._lastVehicle = p.inVehicle || null;

    this._applyShake(cam);

    // ---- FOV
    const kf = this._snap ? 1 : damp(9, dt);
    this.fov += (fovTarget - this.fov) * kf;
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }

    // ---- player model visibility (hidden in first person / camera inside the head)
    if (p.humanoid && p.humanoid.root) {
      const hide = !!p.inVehicle || (p.alive && (this.firstPerson || this._camTooClose));
      p.humanoid.root.visible = !hide;
    }

    // ---- view model
    const vmVisible = this.firstPerson && p.alive && !p.inVehicle && !this.scoped;
    if (vmVisible) this.viewModel.setItem(g.inventory ? g.inventory.getSelected() : null);
    this.viewModel.update(dt, {
      visible: vmVisible,
      speed: p.horizontalSpeed || 0,
      walkDist: p.walkDist || 0,
      onGround: !!p.onGround && !p.inWater,
      sprinting: !!p.sprinting,
      aiming: !!p.aiming,
      dip: this.dip,
    });
    this._snap = false;
  }

  /** Zoom divisor of the current weapon while aiming (1 when not aiming). */
  _currentZoom(p) {
    if (!p.aiming || p.inVehicle || !p.alive) return 1;
    const it = this.game.inventory && this.game.inventory.getSelected();
    const def = it && it.kind === 'weapon' ? WEAPONS[it.id] : null;
    return def && def.zoom > 1 ? def.zoom : 1;
  }

  _footCam(dt, p, fovBase, zoom) {
    const cam = this.game.camera;
    const snap = this._snap;
    // aim blend
    this._aimT += ((p.aiming ? 1 : 0) - this._aimT) * (snap ? 1 : damp(11, dt));
    this.aiming = p.aiming;
    const scoped = p.aiming && zoom >= 3; // sniper: scope view (first person, no view model)
    this.scoped = scoped;
    const fp = this.mode === 'first' || scoped;
    this.firstPerson = fp;

    const stepOff = p.stepOffset || 0;
    const crouch = p.crouchT || 0;
    let fov = fovBase;
    if (p.sprinting && (p.horizontalSpeed || 0) > 5) fov += CAM.sprintFovKick;
    const fpZoom = fp || this.cramped;
    if (zoom > 1) {
      // over the shoulder only part of the zoom applies (the character would fill the screen otherwise)
      const z = fpZoom ? zoom : 1 + (zoom - 1) * CAM.thirdPersonZoom;
      fov = lerp(fov, fovBase / z, this._aimT);
    }

    if (fp) {
      // ---- first person: eye position, direct rotation, subtle view bob
      this.cramped = false; this._crampK = 0; this._crampHold = 0;
      const roll = this._fpEye(p, _eyeP);
      cam.position.copy(_eyeP);
      this._pivot.copy(cam.position);
      cam.rotation.set(this.pitch + this.recoilPitch, this.yaw + Math.PI + this.recoilYaw, roll, 'YXZ');
      this._colDist = 0.5;
      return fov;
    }

    // ---- third person / far / aim
    const base = this.mode === 'far' ? CAM.far : CAM.third;
    const a = this._aimT;
    const tDist = lerp(base.dist, CAM.aim.dist, a);
    const tOff = lerp(base.offset, CAM.aim.offset, a);
    const tH = lerp(base.height, CAM.aim.height, a) - crouch * CAM.crouchDrop;
    const kp = snap ? 1 : damp(8, dt);
    this._dist += (tDist - this._dist) * kp;
    this._off += (tOff - this._off) * kp;
    this._height += (tH - this._height) * kp;

    // pivot follows the player with light damping (vertical softer: steps, jumps)
    const px = p.position.x, py = p.position.y - stepOff + this._height, pz = p.position.z;
    if (snap) this._pivot.set(px, py, pz);
    else {
      const kh = damp(28, dt), kv = damp(p.onGround || p.inWater ? 14 : 9, dt);
      this._pivot.x += (px - this._pivot.x) * kh;
      this._pivot.z += (pz - this._pivot.z) * kh;
      this._pivot.y += (py - this._pivot.y) * kv;
    }
    _pivot.copy(this._pivot);
    _pivot.y += this.dip;

    const yaw = this.yaw + this.recoilYaw, pitch = this.pitch + this.recoilPitch;
    dirFromYawPitch(yaw, pitch, _dir);
    rightFromYaw(this.yaw, _right);

    // shoulder offset (pulled in if a wall is right beside the head)
    let off = this._off;
    if (off > 0.01) {
      const hit = this._castCam(_pivot, _right, off + 0.25);
      if (hit !== null) off = Math.max(0, hit - 0.25);
    }
    _shoulder.copy(_pivot).addScaledVector(_right, off);
    // boom collision: pull in instantly, ease back out
    const want = this._dist;
    _tmp.copy(_dir).negate();
    const hit = this._castCam(_shoulder, _tmp, want + 0.3);
    let allowed = want;
    if (hit !== null) allowed = Math.max(CAM.minDist, hit - 0.3);
    if (snap || allowed < this._colDist) this._colDist = allowed;
    else this._colDist += (allowed - this._colDist) * damp(3.5, dt);
    _desired.copy(_shoulder).addScaledVector(_dir, -this._colDist);
    // room the boom really has (the eased _colDist lags behind when leaving a tight spot or first person)
    let room = allowed;
    // never inside a solid voxel (thin walls / corners the ray missed)
    for (let i = 0; i < 6 && this._solidAt(_desired); i++) {
      this._colDist = Math.max(CAM.minDist * 0.6, this._colDist - 0.35);
      room = Math.min(room, this._colDist);
      _desired.copy(_shoulder).addScaledVector(_dir, -this._colDist);
    }

    // ---- cramped (1x2 tunnels, lobbies, back to a wall): use the first-person eye + view model instead of a
    // head that covers the crosshair or a handless pseudo first person. Hysteresis + a short minimum hold.
    this._crampHold -= dt;
    const shoulderK = this._off > 0.05 ? off / this._off : 1;
    if (!this.cramped) {
      // the shoulder offset collapsing (1-wide tunnel / corridor) puts the head right over the crosshair
      if (room < 1.1 || (shoulderK < 0.5 && room < 3.0)) {
        if (this._crampHold <= 0 || snap) { this.cramped = true; this._crampHold = 0.3; }
      }
    } else if (room > 1.6 && shoulderK >= 0.8 && (this._crampHold <= 0 || snap)) {
      this.cramped = false; this._crampHold = 0.3;
    }
    const kc = snap ? 1 : Math.min(1, dt / 0.15);
    this._crampK = this.cramped ? Math.min(1, this._crampK + kc) : Math.max(0, this._crampK - kc);

    if (this._crampK > 0) {
      const roll = this._fpEye(p, _eyeP);
      const k = this._crampK * this._crampK * (3 - 2 * this._crampK);
      cam.position.lerpVectors(_desired, _eyeP, k);
      cam.rotation.set(pitch, yaw + Math.PI, roll * k, 'YXZ');
      // first-person rules once the camera is mostly at the eye: hides the body, shows the view model, body
      // faces the view and the interaction ray starts at the eye
      if (this._crampK >= 0.5) this.firstPerson = true;
      else this._camTooClose = true; // in between: never look at the inside of the head
      return fov;
    }

    this._camTooClose = this._colDist < 0.75;
    // swimming at the surface: keep the lens above the waterline (no half-submerged view) unless diving
    if (p.swimming && !p.headInWater) this._keepAboveWater(_desired);
    cam.position.copy(_desired);
    cam.rotation.set(pitch, yaw + Math.PI, 0, 'YXZ');
    return fov;
  }

  /** First-person eye position (crouch, step smoothing, view bob, landing dip) into out. Returns the bob roll. */
  _fpEye(p, out) {
    const eye = CAM.eye - (p.crouchT || 0) * CAM.crouchDrop;
    const amp = p.onGround && !p.inWater ? clamp((p.horizontalSpeed || 0) / 4.3, 0, 1.6) * (1 - this._aimT * 0.8) : 0;
    const ph = (p.walkDist || 0) * Math.PI / 1.9;
    const bobY = (Math.abs(Math.cos(ph)) - 0.5) * 0.045 * amp;
    const bobX = Math.sin(ph) * 0.025 * amp;
    rightFromYaw(this.yaw, _right);
    const ty = p.position.y - (p.stepOffset || 0) + eye + bobY + this.dip;
    out.set(p.position.x + _right.x * bobX, ty, p.position.z + _right.z * bobX);
    return Math.sin(ph) * 0.004 * amp;
  }

  /** Chase / far / hood camera. Returns the FOV kick to add. */
  _vehicleCam(dt, p, v) {
    const cam = this.game.camera;
    const def = v.def || {};
    const isHeli = def.kind === 'heli' || v.kind === 'heli';
    const isBike = def.kind === 'bike';
    const vPos = v.position || p.position;
    const vYaw = Number.isFinite(v.yaw) ? v.yaw : p.yaw;
    const speed = Math.abs(v.speed || 0);
    const size = def.size || v.size || { w: 2, h: 1.6, l: 4.5 };
    const entering = this._snapVehicle || this._lastVehicle !== v;
    this._snapVehicle = false;
    const snap = this._snap;
    const hood = this.vehicleMode === 'hood';

    const far = this.vehicleMode === 'far';
    let dist = Number.isFinite(def.camDistance) ? def.camDistance : (isHeli ? CAM.heliDist : CAM.carDist);
    let height = Number.isFinite(def.camHeight) ? def.camHeight : (isHeli ? CAM.heliHeight : CAM.carHeight);
    if (far) { dist *= 1.55; height *= 1.4; }
    const pivotH = clamp((size.h || 1.6) * 0.65, 0.8, 2.5);
    const defPitch = hood ? -0.05 : -clamp(Math.atan2(height - pivotH, dist), 0.05, 0.7);

    // drive-by aiming (Combat sets p.aiming while RMB/LMB is held with a drive-by weapon): blend into the
    // over-the-roof framing; no auto-recentre while aiming, and the look timer stays fresh so releasing the aim
    // does not snap the view back at once
    const driveBy = !!p.aiming && !hood && !isHeli;
    if (p.aiming) this._lastLookTime = this.game.realTime;
    const dbStart = driveBy && this._dbT === 0;
    this._dbT += ((driveBy ? 1 : 0) - this._dbT) * (snap || entering ? 1 : damp(6, dt));
    if (this._dbT < 1e-3) this._dbT = 0;

    // vehicles: keep the camera above the horizon-ish (drive-by: may look up at targets on roofs)
    this.pitch = clamp(this.pitch, -1.25, hood ? 0.6 : lerp(0.3, 0.7, this._dbT));

    // auto-recentre behind the vehicle 1.5 s after the last mouse input (faster when moving)
    const idle = this.game.realTime - this._lastLookTime;
    if (idle > CAM.recentreDelay) {
      const moving = clamp((speed - 0.8) / 6, 0, 1);
      const k = damp(lerp(0.35, 3.0, moving) * (isHeli ? 0.7 : 1), dt);
      this.yaw = wrapAngle(this.yaw + angleDiff(this.yaw, vYaw) * k);
      this.pitch += (defPitch - this.pitch) * damp(1.8, dt);
    }

    if (hood) {
      // hood / driver-eye cam: free look limited to the front hemisphere
      this.firstPerson = true;
      const m = v.meta && v.meta.driver;
      if (m && Number.isFinite(m.y) && typeof v.localToWorld === 'function') {
        // the driver's eye: seat position from the model (+x = driver side) raised to head height
        const up = isHeli ? 0.8 : isBike ? 0.95 : 0.78;
        const fwd = isHeli ? 0.3 : isBike ? 0.15 : 0.05;
        const bob = isHeli ? 0 : clamp(Number(v.susp) || 0, -0.25, 0.25);
        let eyeY = m.y + up;
        if (!isHeli && !isBike && size.h > 0) {
          // just under a low car roof its underside fills the top of the view: drop below it while the steering
          // wheel stays low in the frame (wheel top ~ seat + 0.6), else sit at the roofline (sports cars)
          const roofUnder = size.h - 0.07;
          if (eyeY > roofUnder - 0.13 && eyeY < size.h + 0.04) {
            const low = roofUnder - 0.13;
            eyeY = low >= m.y + 0.66 ? low : size.h + 0.04;
          }
        }
        v.localToWorld(m.x || 0, eyeY + bob, (m.z || 0) + fwd, _desired);
      } else {
        forwardFromYaw(vYaw, _fwd);
        rightFromYaw(vYaw, _right);
        const eyeH = isHeli ? (size.h || 2.5) * 0.55 : Math.max(0.95, (size.h || 1.6) * 0.8);
        const fwdOff = isHeli ? (size.l || 8) * 0.3 : (size.l || 4.5) * 0.05;
        const sideOff = isHeli ? 0 : -(size.w || 2) * 0.18; // driver sits on the left (right-hand traffic)
        _desired.set(vPos.x, vPos.y + eyeH, vPos.z).addScaledVector(_fwd, fwdOff).addScaledVector(_right, sideOff);
      }
      const rel = clamp(angleDiff(vYaw, this.yaw), -2.2, 2.2);
      this.yaw = wrapAngle(vYaw + rel);
      cam.position.copy(_desired);
      cam.rotation.set(this.pitch + this.recoilPitch, this.yaw + Math.PI + this.recoilYaw, 0, 'YXZ');
      this._pivot.copy(_desired);
      this._colDist = 1.2;
      return 4 * smoothstep(12, 40, speed);
    }

    // pull back a little with speed
    dist += Math.min(2.4, speed * 0.05);
    if (entering || snap) {
      this._vehDist = dist;
      this._vehPivotY = vPos.y + pivotH;
      if (entering && !snap) this._colDist = Math.max(1.2, cam.position.distanceTo(_tmp.set(vPos.x, vPos.y + pivotH, vPos.z)));
    }
    this._vehDist += (dist - this._vehDist) * damp(2.5, dt);
    // pivot above the vehicle; vertical smoothing filters bumps / heli bobbing
    this._vehPivotY += (vPos.y + pivotH - this._vehPivotY) * (snap ? 1 : damp(isHeli ? 5 : 9, dt));
    _pivot.set(vPos.x, this._vehPivotY, vPos.z);

    const yaw = this.yaw + this.recoilYaw, pitch = this.pitch + this.recoilPitch;
    dirFromYawPitch(yaw, pitch, _dir);
    _tmp.copy(_dir).negate();
    const hit = this._castCam(_pivot, _tmp, this._vehDist + 0.4);
    let allowed = this._vehDist;
    if (hit !== null) allowed = Math.max(1.2, hit - 0.4);
    if (snap || allowed < this._colDist) this._colDist = allowed;
    else this._colDist += (allowed - this._colDist) * damp(entering ? 6 : 3, dt);
    _desired.copy(_pivot).addScaledVector(_dir, -this._colDist);
    for (let i = 0; i < 6 && this._solidAt(_desired); i++) _desired.y += 0.5;
    cam.position.copy(_desired);

    // look slightly ahead of the vehicle (in its direction of travel)
    forwardFromYaw(vYaw, _fwd);
    const ahead = Math.min(isHeli ? 2.5 : 4.5, speed * 0.12) * ((v.speed || 0) < -0.5 ? -1 : 1);
    _look.copy(_pivot).addScaledVector(_fwd, ahead);
    _look.y += isHeli ? -0.8 : 0.25;
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
    this._pivot.copy(_pivot);

    if (this._dbT > 0) this._driveByFrame(dt, v, size, pivotH, yaw, pitch, snap || entering || dbStart);
    return CAM.vehicleFovKick * smoothstep(14, 42, speed) * (1 - this._dbT);
  }

  /**
   * Drive-by framing, blended over the chase cam by _dbT: the pivot sits above the roof edge on the aim side
   * (at the driver's seat), the camera ~2.6 m behind it along the view, oriented straight from yaw/pitch so the
   * crosshair is exactly getAimRay. The view looks over the roof and out of the aim-side window.
   */
  _driveByFrame(dt, v, size, pivotH, yaw, pitch, snap) {
    const cam = this.game.camera;
    // aim side: +1 = the vehicle's right (hysteresis around straight ahead / behind)
    rightFromYaw(Number.isFinite(v.yaw) ? v.yaw : 0, _right);
    const d = _dir.x * _right.x + _dir.z * _right.z;
    if (snap) this._dbSide = Math.abs(d) > 0.15 ? Math.sign(d) : 0; // aim just started: no slide from the old side
    else if (Math.abs(d) > 0.15) this._dbSide = Math.sign(d);
    this._dbSideS += (this._dbSide - this._dbSideS) * (snap ? 1 : damp(5, dt));
    const m = v.meta && v.meta.driver;
    const lz = m && Number.isFinite(m.z) ? m.z : 0;
    const w = size.w || 2, h = size.h || 1.5;
    // model +x is the driver (left) side, so the right side is -x
    if (typeof v.localToWorld === 'function') v.localToWorld(-this._dbSideS * w * 0.5, 0, lz, _dbPivot);
    else _dbPivot.copy(v.position);
    _dbPivot.y = this._vehPivotY - pivotH + h + 0.6;
    if (this._solidAt(_dbPivot) && typeof v.localToWorld === 'function') {
      // scraping a wall on that side: frame from the middle of the roof instead
      v.localToWorld(0, 0, lz, _dbPivot);
      _dbPivot.y = this._vehPivotY - pivotH + h + 0.6;
    }
    // boom: pull in instantly, ease back out
    _tmp.copy(_dir).negate();
    const hit = this._castCam(_dbPivot, _tmp, 2.6 + 0.3);
    const allowed = hit !== null ? Math.max(0.4, hit - 0.3) : 2.6;
    if (snap || allowed < this._dbDist) this._dbDist = allowed;
    else this._dbDist += (allowed - this._dbDist) * damp(4, dt);
    _dbPos.copy(_dbPivot).addScaledVector(_dir, -this._dbDist);

    const k = this._dbT * this._dbT * (3 - 2 * this._dbT);
    _qa.copy(cam.quaternion);
    _qb.setFromEuler(_euler.set(pitch, yaw + Math.PI, 0, 'YXZ'));
    cam.position.lerp(_dbPos, k);
    if (k >= 0.999) cam.quaternion.copy(_qb);
    else cam.quaternion.slerpQuaternions(_qa, _qb, k);
  }

  _deathCam(dt, p) {
    const cam = this.game.camera;
    if (this._deathT === 0) {
      _tmp.subVectors(cam.position, p.position); _tmp.y = 0;
      this._deathAngle = _tmp.lengthSq() > 0.01 ? Math.atan2(_tmp.x, _tmp.z) : this.yaw + Math.PI;
      this._camPos.copy(cam.position);
    }
    this._deathT += dt;
    const t = this._deathT;
    this._deathAngle += dt * 0.12;
    const r = Math.min(6, 3 + t * 0.9);
    const h = Math.min(9, 2.2 + t * 1.5);
    _desired.set(p.position.x + Math.sin(this._deathAngle) * r, p.position.y + h, p.position.z + Math.cos(this._deathAngle) * r);
    // keep out of walls: raise until free
    for (let i = 0; i < 8 && this._solidAt(_desired); i++) _desired.y += 1;
    this._camPos.lerp(_desired, damp(1.4, dt));
    cam.position.copy(this._camPos);
    _look.set(p.position.x, p.position.y + 0.4, p.position.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
  }

  _titleOrbit(dt) {
    const g = this.game;
    const cam = g.camera;
    this.viewModel.update(dt, { visible: false });
    const plan = g.generator && g.generator.plan;
    const s = (plan && plan.spawn) || { x: 256, y: 28, z: 256 };
    const a = (g.realTime || 0) * CAM.titleSpeed + 0.6;
    const R = CAM.titleRadius;
    _desired.set(s.x + Math.cos(a) * R, s.y + CAM.titleHeight, s.z + Math.sin(a) * R);
    // stay inside the world
    _desired.x = clamp(_desired.x, 2, 510); _desired.z = clamp(_desired.z, 2, 510);
    cam.position.copy(_desired);
    _look.set(s.x, s.y + 8, s.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(_look);
    const f = g.settings.fov || 75;
    if (Math.abs(cam.fov - f) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
    this.fov = f;
  }

  _applyShake(cam) {
    const s = this.trauma * this.trauma;
    if (s <= 0.0001) return;
    const t = this.game.realTime * 26;
    cam.rotation.x += s * 0.075 * wobble(t);
    cam.rotation.y += s * 0.075 * wobble(t + 17.3);
    cam.rotation.z += s * 0.06 * wobble(t + 41.1);
    if (!this.firstPerson) {
      cam.position.x += s * 0.14 * wobble(t * 1.1 + 5.2);
      cam.position.y += s * 0.14 * wobble(t * 1.1 + 9.4);
      cam.position.z += s * 0.14 * wobble(t * 1.1 + 2.8);
    }
  }

  /** Voxel ray for camera collision. Returns hit distance or null. Ignores non-solid and liquid blocks. */
  _castCam(origin, dir, maxDist) {
    const w = this.game.world;
    if (!w || typeof w.getBlock !== 'function') return null;
    const hit = voxelRaycast(w, origin, dir, maxDist, { hitNonSolid: false, hitLiquid: false });
    if (!hit) return null;
    const def = BLOCKS[hit.id];
    if (def && def.cutout && def.shape === 'cross') return null;
    return hit.distance;
  }

  /** If v is inside water, lift it just above the surface (max 3 blocks), unless a solid block is in the way. */
  _keepAboveWater(v) {
    const w = this.game.world;
    if (!w || typeof w.getBlock !== 'function') return;
    const x = Math.floor(v.x), z = Math.floor(v.z);
    let y = Math.floor(v.y);
    const liquid = (id) => !!(BLOCKS[id] && BLOCKS[id].liquid);
    if (!liquid(w.getBlock(x, y, z))) {
      // just above a surface: the water top face renders at ~0.875, keep a small clearance
      if (liquid(w.getBlock(x, y - 1, z)) && v.y - y < 0.2) v.y = y + 0.2;
      return;
    }
    for (let i = 0; i < 3; i++) {
      y++;
      const id = w.getBlock(x, y, z);
      if (BLOCKS[id] && BLOCKS[id].solid) return;
      if (!liquid(id)) { v.y = Math.max(v.y, y + 0.2); return; }
    }
  }

  _solidAt(v) {
    const w = this.game.world;
    if (!w || typeof w.isSolid !== 'function') return false;
    return !!w.isSolid(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
  }
}
