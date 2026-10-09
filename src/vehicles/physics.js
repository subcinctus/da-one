// Arcade vehicle physics (pure functions over Vehicle state; no THREE scene access). Used by Vehicles.update.
//
// Cars/bikes: bicycle-model yaw rate with speed-sensitive steering, forward/lateral velocity split with lateral grip
// decay (handbrake = rear grip loss -> powerslides), engine curve, brakes, reverse, drag + rolling resistance,
// ground following over voxels (corner sampling, step-up <= 1.05, gravity off ledges), oriented-box vs block
// collisions with rigid-body impulses (bounce + scrape + spin), water.
// Helicopters: rotor spin-up, lift, pitch-to-accelerate, yaw, drag, landing on any solid surface.
// Vehicle vs vehicle: 2D OBB SAT with mass-weighted impulses.
import { PHYS } from '../core/config.js';
import { BLOCKS } from '../world/blocks.js';
import { clamp, smoothstep, angleDiff } from '../core/math.js';

const G = PHYS.GRAVITY;
export const STEP_HEIGHT = 1.05;

// per-block surface: grip & traction multipliers
const SURF = new Float32Array(256).fill(1);
const TRAC = new Float32Array(256).fill(1);
const LIQ = new Uint8Array(256);
for (const d of BLOCKS) {
  if (!d) continue;
  const k = d.key;
  if (d.liquid) LIQ[d.id] = 1;
  if (k === 'GRASS' || k === 'DIRT' || k === 'GRAVEL') { SURF[d.id] = 0.78; TRAC[d.id] = 0.86; }
  if (k === 'SAND' || k === 'SNOW') { SURF[d.id] = 0.66; TRAC[d.id] = 0.72; }
  if (k === 'LEAVES' || k === 'HEDGE' || k === 'PALM_LEAVES') { SURF[d.id] = 0.7; TRAC[d.id] = 0.8; }
}

/** Is the block liquid? */
export const isLiquidId = (id) => LIQ[id] === 1;

/**
 * Standing height under (x, z) for a wheel/corner, relative to the vehicle's current height refY.
 * Returns: number (top of the support block), NaN if the column is blocked above step height (a wall),
 * or -Infinity if nothing within `depth` blocks below. Sets out.id to the support block id when given.
 */
export function sampleGround(world, x, z, refY, depth = 6, out = null) {
  const bx = Math.floor(x), bz = Math.floor(z);
  const top = Math.floor(refY + STEP_HEIGHT);
  if (world.isSolid(bx, top, bz)) return NaN;
  const lo = Math.floor(refY) - depth;
  for (let y = top - 1; y >= lo; y--) {
    if (world.isSolid(bx, y, bz)) {
      if (out) out.id = world.getBlock(bx, y, bz);
      return y + 1;
    }
  }
  return -Infinity;
}

/** Build local collision sample points for a def. Returns {pts: Float32Array(x,z pairs), ys: number[], rotor: Float32Array}. */
export function buildSamples(def) {
  const hw = def.size.w / 2 - 0.03, hl = def.size.l / 2 - 0.03;
  const pts = [];
  const nx = Math.max(1, Math.ceil((hw * 2) / 0.8)), nz = Math.max(1, Math.ceil((hl * 2) / 0.8));
  for (let i = 0; i <= nz; i++) { const z = -hl + (2 * hl * i) / nz; pts.push(hw, z, -hw, z); }
  for (let i = 1; i < nx; i++) { const x = -hw + (2 * hw * i) / nx; pts.push(x, hl, x, -hl); }
  const ys = [];
  const h = def.size.h;
  if (def.kind === 'heli') {
    for (let y = 0.35; y < h - 0.1; y += 0.75) ys.push(y);
  } else {
    const y0 = STEP_HEIGHT + 0.06, y1 = Math.max(y0, h - 0.12);
    const n = Math.max(1, Math.ceil((y1 - y0) / 0.9));
    for (let i = 0; i <= n; i++) ys.push(y0 + ((y1 - y0) * i) / n);
    if (ys.length > 1 && ys[ys.length - 1] - ys[ys.length - 2] < 0.15) ys.pop();
  }
  // ground probe points (corners inset + front/rear centre)
  const gx = Math.max(0.12, def.size.w / 2 - 0.28), gz = Math.max(0.3, def.size.l / 2 - 0.45);
  const ground = def.kind === 'bike'
    ? [0.14, gz, -0.14, gz, 0.14, -gz, -0.14, -gz, 0, gz, 0, -gz]
    : [gx, gz, -gx, gz, gx, -gz, -gx, -gz, 0, gz, 0, -gz];
  const rotor = [];
  if (def.rotorRadius) {
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; rotor.push(Math.sin(a) * def.rotorRadius * 0.96, Math.cos(a) * def.rotorRadius * 0.96); }
  }
  return { pts: Float32Array.from(pts), ys, ground: Float32Array.from(ground), rotor: Float32Array.from(rotor), gx, gz };
}

// ------------------------------------------------------------------------------------------------ cars
const _gs = { id: 0 };

/**
 * Advance a car/bike by h seconds. v: Vehicle (see vehicle.js). world: {isSolid, getBlock}.
 */
export function stepCar(v, h, world) {
  const d = v.def, c = v.controls, vel = v.velocity, pos = v.position;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  let vF = vel.x * sy + vel.z * cy;
  let vR = -vel.x * cy + vel.z * sy;

  // ---- inputs (wrecks / flooded / driverless coast to a stop)
  let thr = clamp(+c.throttle || 0, -1, 1), brk = clamp(+c.brake || 0, 0, 1), hb = !!c.handbrake;
  let steerIn = clamp(+c.steer || 0, -1, 1);
  if (v.destroyed || v.flooded) { thr = 0; hb = false; steerIn = 0; brk = Math.max(brk, v.destroyed ? 0.35 : 0.1); }
  else if (!v.driver) { thr = 0; hb = false; brk = Math.max(brk, v.parked || Math.abs(vF) < 1.5 ? 1 : 0.1); }
  const sr = Math.abs(steerIn) < Math.abs(v.steer) || steerIn * v.steer < 0 ? 7.5 : 4.4;
  v.steer += clamp(steerIn - v.steer, -sr * h, sr * h);

  const spd = Math.abs(vF);
  const sgn = vF >= 0 ? 1 : -1;
  let aLong = 0;
  if (v.onGround) {
    const gm = v.surfGrip, tm = v.surfTrac;
    // ---- longitudinal
    let drive = 0, decel = 0;
    const vmax = d.maxSpeed;
    v.braking = false; v.reversing = false;
    if (thr > 0.01) {
      if (vF < -0.8) { decel += d.brake * thr; v.braking = true; }
      else {
        const f = Math.max(0, vF) / (vmax * 1.03);
        const curve = Math.max(0, 1 - f * f * f) * (0.82 + 0.18 * Math.min(1, f * 3));
        drive += d.accel * tm * thr * curve * (hb ? 0.7 : 1);
      }
    } else if (thr < -0.01) {
      if (vF > 0.8) { decel += d.brake * -thr; v.braking = true; }
      else {
        const rf = Math.max(0, 1 - -vF / d.reverseSpeed);
        drive -= d.accel * 0.62 * tm * -thr * rf;
        v.reversing = vF < -0.3;
      }
    }
    if (brk > 0) { decel += d.brake * brk; if (brk > 0.2 && spd > 0.5) v.braking = true; }
    if (hb) { decel += d.brake * (thr > 0.01 ? 0.08 : 0.42); v.braking = v.braking || spd > 0.5; }
    if (Math.abs(thr) < 0.01) decel += 0.45 + 0.9 * Math.min(1, spd / 8); // rolling resistance + engine braking
    decel += (1 - gm) * 0.6;                                               // soft ground
    drive -= 0.00055 * vF * Math.abs(vF);                                  // aero drag
    const before = vF;
    vF += drive * h;
    const dv = decel * h;
    if (Math.abs(vF) <= dv) vF = 0; else vF -= Math.sign(vF) * dv;
    if (thr === 0 && before !== 0 && Math.sign(vF) !== Math.sign(before)) vF = 0;
    aLong = (vF - before) / h;

    // ---- lateral grip (with decay when sliding, handbrake = rear grip loss)
    const beta = Math.atan2(Math.abs(vR), Math.max(spd, 2));
    const hbActive = hb && spd > 3;
    const gripTarget = hbActive ? 0.16 : 1;
    v.gripF += (gripTarget - v.gripF) * (1 - Math.exp(-(gripTarget < v.gripF ? 7 : 2.4) * h));
    let grip = d.grip * gm * v.gripF * (1 - 0.5 * smoothstep(0.14, 0.7, beta) * Math.min(1.4, d.drift));
    if (d.kind === 'bike') grip *= 1.15;
    const k = Math.exp(-grip * h);
    const nR = vR * k;
    const removed = Math.abs(vR - nR);
    const sp2 = vF * vF + vR * vR;
    vR = nR;
    if (spd > 3 && beta > 0.18) {
      // drift exits keep some momentum (never more than the speed the car already had)
      vF += sgn * removed * 0.16;
      const s2 = vF * vF + vR * vR;
      if (s2 > sp2) vF = sgn * Math.sqrt(Math.max(0, sp2 - vR * vR));
    }
    v.slip = Math.abs(vR);

    // ---- yaw (bicycle model)
    const L = d.wheelbase;
    const steerMax = d.steer / (1 + spd / 21);
    const delta = v.steer * steerMax;
    const raw = -(vF / L) * Math.tan(delta);
    const maxLat = d.grip * 1.7 * gm * (d.kind === 'bike' ? 1.1 : 1);
    const capW = maxLat / Math.max(spd, 1);
    let wt = clamp(raw, -capW, capW);
    // handbrake: the rear steps out -> rotate well past the grip limit (snappy, still steerable / counter-steerable)
    if (hbActive) wt = clamp(raw * 1.5, -2.1 * d.drift, 2.1 * d.drift);
    if (hb && thr > 0.3 && spd < 6 && Math.abs(v.steer) > 0.3) wt = -Math.sign(v.steer) * 2.6 * thr; // donut
    const resp = 2.2 + 8.5 * v.gripF;
    v.yawRate += (wt - v.yawRate) * (1 - Math.exp(-resp * h));
    v.cornerLoad = Math.abs(vF * v.yawRate) / maxLat; // ~1 = cornering at the grip limit (tyre squeal)
    v.burnout = hb && thr > 0.3 && spd < 8;
  } else {
    // airborne: no traction, yaw slowly settles, light air drag
    v.yawRate *= Math.exp(-0.6 * h);
    vF *= Math.exp(-0.02 * h);
    v.slip = 0; v.burnout = false; v.braking = false; v.cornerLoad = 0;
  }
  v.aLong += (aLong - v.aLong) * (1 - Math.exp(-6 * h));

  // ---- water: heavy drag, flooding
  if (v.inWater) {
    const wd = Math.exp(-2.2 * h);
    vF *= wd; vR *= wd; v.yawRate *= Math.exp(-2.5 * h);
  }

  // recompose with the pre-rotation frame (velocity stays in world space -> slides when the car rotates)
  vel.x = sy * vF - cy * vR;
  vel.z = cy * vF + sy * vR;
  v.yaw += v.yawRate * h;
  pos.x += vel.x * h;
  pos.z += vel.z * h;

  verticalCar(v, h, world);
  collideWorld(v, world, 0.22, 0.35);
}

/** Ground following + gravity + landing for cars/bikes. */
function verticalCar(v, h, world) {
  const pos = v.position, S = v.samples, gp = S.ground;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const hs = v.gh; // heights per probe
  let maxH = -Infinity, nWall = 0;
  let gSurf = 1, gTrac = 1;
  for (let i = 0, k = 0; i < gp.length; i += 2, k++) {
    const lx = gp[i], lz = gp[i + 1];
    const wx = pos.x + lx * cy + lz * sy, wz = pos.z - lx * sy + lz * cy;
    _gs.id = 0;
    const gy = sampleGround(world, wx, wz, pos.y, 7, _gs);
    if (Number.isNaN(gy)) { hs[k] = pos.y; nWall++; continue; }
    hs[k] = gy;
    if (gy > maxH) maxH = gy;
    if (gy > -Infinity && _gs.id) { gSurf = Math.min(gSurf, SURF[_gs.id]); gTrac = Math.min(gTrac, TRAC[_gs.id]); }
  }
  v.surfGrip += (gSurf - v.surfGrip) * Math.min(1, h * 8);
  v.surfTrac += (gTrac - v.surfTrac) * Math.min(1, h * 8);
  // corners: 0 FL(+x,+z) 1 FR 2 RL 3 RR, 4 front centre, 5 rear centre
  const hv = (k) => (hs[k] === -Infinity ? pos.y - 1.6 : hs[k]);
  const hF = Math.max(hv(0), hv(1), hv(4)), hR = Math.max(hv(2), hv(3), hv(5));
  const hL = Math.max(hv(0), hv(2)), hRt = Math.max(hv(1), hv(3));
  let target = -Infinity;
  if (maxH > -Infinity) target = Math.max((hF + hR) * 0.5, maxH - 0.55);

  // visual terrain pitch / roll
  const span = Math.max(0.6, S.gz * 2), track = Math.max(0.3, S.gx * 2);
  let pitchT, rollT;
  if (v.onGround || pos.y - target < 0.6) {
    pitchT = clamp(-Math.atan2(hF - hR, span), -0.38, 0.38);
    rollT = v.def.kind === 'bike' ? 0 : clamp(Math.atan2(hL - hRt, track), -0.26, 0.26);
  } else {
    pitchT = clamp(-v.velocity.y * 0.018, -0.35, 0.4);
    rollT = v.roll * 0.98;
  }
  const kp = 1 - Math.exp(-(v.onGround ? 14 : 3) * h);
  v.pitch += (pitchT - v.pitch) * kp;
  v.roll += (rollT - v.roll) * kp;

  // water check (block at wheel-hub height / mid body)
  const bx = Math.floor(pos.x), bz = Math.floor(pos.z);
  v.inWater = LIQ[world.getBlock(bx, Math.floor(pos.y + 0.35), bz)] === 1;
  const deep = v.inWater && LIQ[world.getBlock(bx, Math.floor(pos.y + Math.min(1.1, v.def.size.h * 0.55)), bz)] === 1;
  if (deep) v.flooded = true;

  const vel = v.velocity;
  if (target > -Infinity && pos.y <= target + 0.02) {
    if (!v.onGround) {
      const impact = Math.max(0, -vel.y);
      if (impact > v.landImpact) v.landImpact = impact;
    }
    const dy = target - pos.y;
    if (dy > 0) pos.y += Math.min(dy, Math.max(dy * 16 * h, 2.6 * h));
    if (vel.y < 0) vel.y = 0;
    if (vel.y > 0) pos.y += vel.y * h; // launched (explosion) while touching ground
    v.onGround = vel.y <= 0.01;
    if (v.onGround) v.airTime = 0;
  } else {
    const drop = pos.y - target;
    const stick = v.onGround && drop < 1.15 && vel.y <= 0;
    vel.y -= G * (stick ? 2.6 : 1) * h;
    if (v.inWater) { vel.y = Math.max(vel.y, v.flooded ? -1.3 : -2.2); }
    vel.y = Math.max(vel.y, -PHYS.TERMINAL_VELOCITY);
    pos.y += vel.y * h;
    if (target > -Infinity && pos.y <= target) {
      const impact = Math.max(0, -vel.y);
      if (impact > v.landImpact && !stick) v.landImpact = impact;
      pos.y = target; vel.y = 0;
      v.onGround = true; v.airTime = 0;
    } else {
      v.onGround = false;
      v.airTime += h;
    }
  }
  return nWall;
}

// ------------------------------------------------------------------------------------------------ collisions
const _contact = { px: 0, pz: 0, nx: 0, nz: 0, pen: 0, found: false };

/** Deepest perimeter-sample contact against solid blocks. */
function deepestContact(v, world, out) {
  const pos = v.position, S = v.samples, pts = S.pts, ys = S.ys;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  out.found = false; out.pen = 0;
  for (let yi = 0; yi < ys.length; yi++) {
    const by = Math.floor(pos.y + ys[yi]);
    for (let i = 0; i < pts.length; i += 2) {
      const lx = pts[i], lz = pts[i + 1];
      const wx = pos.x + lx * cy + lz * sy, wz = pos.z - lx * sy + lz * cy;
      const bx = Math.floor(wx), bz = Math.floor(wz);
      if (!world.isSolid(bx, by, bz)) continue;
      // candidate exit faces (only toward a free neighbour, and not pulling the body further in)
      const tcx = pos.x - wx, tcz = pos.z - wz;
      let best = Infinity, nx = 0, nz = 0;
      const tryFace = (d, fx, fz, free) => {
        if (!free) return;
        const toward = fx * tcx + fz * tcz;
        const dd = toward < -0.05 ? d + 2 : d;
        if (dd < best) { best = dd; nx = fx; nz = fz; }
      };
      tryFace(wx - bx, -1, 0, !world.isSolid(bx - 1, by, bz));
      tryFace(bx + 1 - wx, 1, 0, !world.isSolid(bx + 1, by, bz));
      tryFace(wz - bz, 0, -1, !world.isSolid(bx, by, bz - 1));
      tryFace(bz + 1 - wz, 0, 1, !world.isSolid(bx, by, bz + 1));
      if (best === Infinity) {
        // buried: push toward the vehicle centre
        const l = Math.hypot(tcx, tcz) || 1;
        nx = tcx / l; nz = tcz / l; best = 0.25;
      } else if (best > 2) best -= 2;
      if (best > out.pen) { out.pen = best; out.px = wx; out.pz = wz; out.nx = nx; out.nz = nz; out.found = true; }
    }
  }
  return out;
}

/**
 * Resolve block penetration with rigid-body impulses (restitution e, friction mu).
 * Records v.impact (max normal speed), v.scrape (tangential speed), v.contactX/Z/NX/NZ.
 */
export function collideWorld(v, world, e = 0.22, mu = 0.35) {
  const vel = v.velocity, pos = v.position;
  const w = v.def.size.w, l = v.def.size.l;
  const invI = 12 / (w * w + l * l) * 0.7;
  let hits = 0;
  for (let it = 0; it < 4; it++) {
    const c = deepestContact(v, world, _contact);
    if (!c.found) break;
    hits++;
    pos.x += c.nx * (c.pen + 0.002);
    pos.z += c.nz * (c.pen + 0.002);
    const rx = c.px - pos.x, rz = c.pz - pos.z;
    const w0 = v.yawRate;
    const vpx = vel.x + w0 * rz, vpz = vel.z - w0 * rx;
    const vn = vpx * c.nx + vpz * c.nz;
    if (vn < 0) {
      const rn = rz * c.nx - rx * c.nz;
      const j = (-(1 + e) * vn) / (1 + rn * rn * invI);
      vel.x += j * c.nx; vel.z += j * c.nz;
      v.yawRate += j * rn * invI;
      // friction (scrape)
      const tx = -c.nz, tz = c.nx;
      const vt = (vel.x + v.yawRate * rz) * tx + (vel.z - v.yawRate * rx) * tz;
      const rt = rz * tx - rx * tz;
      let jt = -vt / (1 + rt * rt * invI);
      jt = clamp(jt, -mu * j, mu * j);
      vel.x += jt * tx; vel.z += jt * tz;
      v.yawRate += jt * rt * invI;
      if (-vn > v.impact) { v.impact = -vn; v.contactX = c.px; v.contactZ = c.pz; v.contactNX = c.nx; v.contactNZ = c.nz; }
      v.scrape = Math.max(v.scrape, Math.abs(vt));
    } else {
      v.scrape = Math.max(v.scrape, Math.abs(vpx * -c.nz + vpz * c.nx) * 0.5);
    }
    v.contactX = c.px; v.contactZ = c.pz; v.contactNX = c.nx; v.contactNZ = c.nz; v.touching = true;
  }
  v.yawRate = clamp(v.yawRate, -6, 6);
  return hits;
}

// ------------------------------------------------------------------------------------------------ helicopter
/** Advance a helicopter by h seconds. */
export function stepHeli(v, h, world) {
  const d = v.def, c = v.controls, vel = v.velocity, pos = v.position;
  const pilot = !!v.driver && !v.destroyed && !v.flooded;
  const target = pilot ? 1 : 0;
  v.rotor += clamp(target - v.rotor, -0.3 * h, 0.42 * h);
  const R2 = v.rotor * v.rotor;
  let lift = pilot ? clamp(+c.lift || 0, -1, 1) : 0;
  let thr = pilot ? clamp(+c.throttle || 0, -1, 1) : 0;
  let st = pilot ? clamp(+c.steer || 0, -1, 1) : 0;
  if (v.onFire && !v.onGround) { lift = Math.min(lift, -0.25); st += 0.8; } // losing control

  // ---- tilt (pitch forward to accelerate) and bank
  const tiltT = v.onGround ? 0 : thr * 0.32;
  v.tilt += (tiltT - v.tilt) * (1 - Math.exp(-3.2 * h));
  const bankT = v.onGround ? 0 : clamp(st, -1, 1) * 0.26;
  v.bank += (bankT - v.bank) * (1 - Math.exp(-3 * h));

  // ---- vertical
  const ay = R2 * (G + lift * 12.5) - G - vel.y * (0.15 + 1.35 * R2);
  vel.y += ay * h;
  vel.y = clamp(vel.y, -PHYS.TERMINAL_VELOCITY, 14);

  // ---- horizontal
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  let vF = vel.x * sy + vel.z * cy;
  let vR = -vel.x * cy + vel.z * sy;
  if (!v.onGround) {
    const acc = (d.accel / 11) * G * Math.tan(v.tilt) * R2;
    vF += acc * h;
    vR += v.bank * 4.5 * R2 * h; // bank -> slight sideways drift into the turn
  }
  const sp = Math.hypot(vF, vR);
  const kl = 0.12, kq = Math.max(0.0005, (d.accel - kl * d.maxSpeed) / (d.maxSpeed * d.maxSpeed));
  const drag = Math.exp(-(kl + kq * sp) * h);
  vF *= drag;
  vR *= drag * Math.exp(-0.9 * h);
  if (v.onGround) { const f = Math.exp(-5 * h); vF *= f; vR *= f; }
  vel.x = sy * vF - cy * vR;
  vel.z = cy * vF + sy * vR;
  v.speed = vF;

  // ---- yaw
  const canYaw = !v.onGround || v.rotor > 0.6;
  const wt = canYaw ? -st * d.steer * (0.35 + 0.65 * R2) : 0;
  v.yawRate += (wt - v.yawRate) * (1 - Math.exp(-2.6 * h));
  if (v.onFire && !v.onGround) v.yawRate += 2.2 * h;
  v.yaw += v.yawRate * h;
  v.steer = st;

  pos.x += vel.x * h;
  pos.z += vel.z * h;
  pos.y += vel.y * h;
  if (pos.y > 150) { pos.y = 150; vel.y = Math.min(0, vel.y); }

  // ---- ground (skids): scan a few blocks below the skid probes
  const gp = v.samples.ground;
  let gy = -Infinity;
  for (let i = 0; i < gp.length; i += 2) {
    const wx = pos.x + gp[i] * cy + gp[i + 1] * sy, wz = pos.z - gp[i] * sy + gp[i + 1] * cy;
    const bx = Math.floor(wx), bz = Math.floor(wz);
    const top = Math.floor(pos.y + 0.6);
    for (let y = top; y >= top - 3; y--) {
      if (world.isSolid(bx, y, bz)) { if (y + 1 > gy) gy = y + 1; break; }
    }
  }
  const bx = Math.floor(pos.x), bz = Math.floor(pos.z);
  v.inWater = LIQ[world.getBlock(bx, Math.floor(pos.y + 0.3), bz)] === 1;
  if (v.inWater && LIQ[world.getBlock(bx, Math.floor(pos.y + 1.2), bz)] === 1) v.flooded = true;
  if (v.inWater) { vel.y = Math.max(vel.y, -1.4); const f = Math.exp(-2 * h); vel.x *= f; vel.z *= f; }
  if (gy > -Infinity && pos.y <= gy + 0.02) {
    if (!v.onGround) { const impact = Math.max(0, -vel.y); if (impact > v.landImpact) v.landImpact = impact; }
    if (pos.y < gy) pos.y = Math.min(gy, pos.y + Math.max((gy - pos.y) * 20 * h, 3 * h));
    if (vel.y < 0) vel.y = 0;
    v.onGround = vel.y <= 0.5;
    if (v.onGround) v.airTime = 0;
  } else {
    v.onGround = false;
    v.airTime += h;
  }
  v.pitch = v.tilt;
  v.roll = v.bank;
  v.slip = 0;

  collideWorld(v, world, 0.35, 0.3);
  rotorStrike(v, world);
}

/** Rotor-disc strike: blocks inside the disc damage + push the heli away. */
function rotorStrike(v, world) {
  const rp = v.samples.rotor;
  if (!rp.length || v.rotor < 0.2) return;
  const pos = v.position;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const ry = Math.floor(pos.y + 2.62);
  let pushX = 0, pushZ = 0, n = 0;
  for (let i = 0; i < rp.length; i += 2) {
    const wx = pos.x + rp[i] * cy + rp[i + 1] * sy, wz = pos.z - rp[i] * sy + rp[i + 1] * cy;
    if (world.isSolid(Math.floor(wx), ry, Math.floor(wz))) { pushX += pos.x - wx; pushZ += pos.z - wz; n++; }
  }
  if (!n) return;
  const l = Math.hypot(pushX, pushZ) || 1;
  const nx = pushX / l, nz = pushZ / l;
  const vn = v.velocity.x * nx + v.velocity.z * nz;
  if (vn < 0) { v.velocity.x -= vn * 1.6 * nx; v.velocity.z -= vn * 1.6 * nz; }
  v.velocity.x += nx * 2.5; v.velocity.z += nz * 2.5;
  v.rotorStrike = Math.max(v.rotorStrike, 1 + Math.abs(vn));
}

// ------------------------------------------------------------------------------------------------ autopilot
/** Fill heli controls to fly toward v.autopilot {x, y, z} (AI helicopters). */
export function heliAutopilot(v) {
  const t = v.autopilot, c = v.controls, pos = v.position;
  if (!t) return;
  const dx = t.x - pos.x, dz = t.z - pos.z;
  const dist = Math.hypot(dx, dz);
  const want = Math.atan2(dx, dz);
  const err = angleDiff(v.yaw, want);
  c.steer = dist > 3 ? clamp(-err * 1.8, -1, 1) : 0;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const vF = v.velocity.x * sy + v.velocity.z * cy;
  const desired = Math.min(v.def.maxSpeed * 0.75, dist * 0.45) * Math.max(0, Math.cos(err));
  c.throttle = clamp((desired - vF) / 9, -1, 1);
  c.lift = clamp((t.y - pos.y) * 0.3 - v.velocity.y * 0.35, -1, 1);
}

// ------------------------------------------------------------------------------------------------ vehicle vs vehicle
const _ax = [0, 0, 0, 0], _az = [0, 0, 0, 0];

/**
 * 2D OBB vs OBB (SAT) with positional correction and mass-weighted impulses (restitution e).
 * Returns the relative normal impact speed (0 if not colliding). Writes the contact point/normal to out.
 */
export function collidePair(a, b, out, e = 0.25) {
  const pa = a.position, pb = b.position;
  const dx = pa.x - pb.x, dz = pa.z - pb.z;
  const ra = a.boundR, rb = b.boundR;
  if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return 0;
  const ha = a.def.size.h, hb = b.def.size.h;
  if (pa.y >= pb.y + hb - 0.15 || pb.y >= pa.y + ha - 0.15) return 0;
  const sa = Math.sin(a.yaw), ca = Math.cos(a.yaw), sb = Math.sin(b.yaw), cb = Math.cos(b.yaw);
  // axes: a.forward, a.right, b.forward, b.right
  _ax[0] = sa; _az[0] = ca; _ax[1] = -ca; _az[1] = sa; _ax[2] = sb; _az[2] = cb; _ax[3] = -cb; _az[3] = sb;
  const awh = a.def.size.w / 2, alh = a.def.size.l / 2, bwh = b.def.size.w / 2, blh = b.def.size.l / 2;
  let minO = Infinity, nx = 0, nz = 0;
  for (let i = 0; i < 4; i++) {
    const axx = _ax[i], axz = _az[i];
    const ea = awh * Math.abs(-ca * axx + sa * axz) + alh * Math.abs(sa * axx + ca * axz);
    const eb = bwh * Math.abs(-cb * axx + sb * axz) + blh * Math.abs(sb * axx + cb * axz);
    const dist = dx * axx + dz * axz;
    const o = ea + eb - Math.abs(dist);
    if (o <= 0) return 0;
    if (o < minO) { minO = o; const s = dist >= 0 ? 1 : -1; nx = axx * s; nz = axz * s; }
  }
  // contact point: deepest corner of either box inside the other (fallback: midpoint)
  let cx = 0, cz = 0, cn = 0;
  const corners = (p, s, c, hw, hl, q, sq, cq, qhw, qhl) => {
    for (const ix of [-1, 1]) {
      for (const iz of [-1, 1]) {
        const lx = ix * hw, lz = iz * hl;
        const wx = p.x + lx * c + lz * s, wz = p.z - lx * s + lz * c;
        const rx = wx - q.x, rz = wz - q.z;
        const lf = rx * sq + rz * cq, lr = -rx * cq + rz * sq;
        if (Math.abs(lf) <= qhl + 0.05 && Math.abs(lr) <= qhw + 0.05) { cx += wx; cz += wz; cn++; }
      }
    }
  };
  corners(pa, sa, ca, awh, alh, pb, sb, cb, bwh, blh);
  corners(pb, sb, cb, bwh, blh, pa, sa, ca, awh, alh);
  if (cn) { cx /= cn; cz /= cn; } else { cx = (pa.x + pb.x) / 2; cz = (pa.z + pb.z) / 2; }
  const ma = a.sleeping && !b.sleeping ? a.def.mass * 1.6 : a.def.mass, mb = b.sleeping && !a.sleeping ? b.def.mass * 1.6 : b.def.mass;
  const ima = 1 / ma, imb = 1 / mb;
  const corr = Math.min(minO, 0.6) + 0.002;
  pa.x += nx * corr * (ima / (ima + imb)); pa.z += nz * corr * (ima / (ima + imb));
  pb.x -= nx * corr * (imb / (ima + imb)); pb.z -= nz * corr * (imb / (ima + imb));
  const Ia = ma * (a.def.size.w ** 2 + a.def.size.l ** 2) / 12 / 0.7, Ib = mb * (b.def.size.w ** 2 + b.def.size.l ** 2) / 12 / 0.7;
  const rax = cx - pa.x, raz = cz - pa.z, rbx = cx - pb.x, rbz = cz - pb.z;
  const vax = a.velocity.x + a.yawRate * raz, vaz = a.velocity.z - a.yawRate * rax;
  const vbx = b.velocity.x + b.yawRate * rbz, vbz = b.velocity.z - b.yawRate * rbx;
  const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
  if (out) { out.x = cx; out.z = cz; out.nx = nx; out.nz = nz; out.y = Math.max(pa.y, pb.y) + 0.6; }
  if (vn >= 0) return 0.0001;
  const ran = raz * nx - rax * nz, rbn = rbz * nx - rbx * nz;
  const j = (-(1 + e) * vn) / (ima + imb + ran * ran / Ia + rbn * rbn / Ib);
  a.velocity.x += j * nx * ima; a.velocity.z += j * nz * ima; a.yawRate += j * ran / Ia;
  b.velocity.x -= j * nx * imb; b.velocity.z -= j * nz * imb; b.yawRate -= j * rbn / Ib;
  // tangential friction
  const tx = -nz, tz = nx;
  const vt = (vax - vbx) * tx + (vaz - vbz) * tz;
  const rat = raz * tx - rax * tz, rbt = rbz * tx - rbx * tz;
  let jt = -vt / (ima + imb + rat * rat / Ia + rbt * rbt / Ib);
  jt = clamp(jt, -0.4 * j, 0.4 * j);
  a.velocity.x += jt * tx * ima; a.velocity.z += jt * tz * ima; a.yawRate += jt * rat / Ia;
  b.velocity.x -= jt * tx * imb; b.velocity.z -= jt * tz * imb; b.yawRate -= jt * rbt / Ib;
  a.yawRate = clamp(a.yawRate, -6, 6); b.yawRate = clamp(b.yawRate, -6, 6);
  return -vn;
}

/**
 * Point (entity at px,pz with radius r) vs vehicle OBB. Returns penetration depth (>0) and writes the
 * push-out normal (from the vehicle toward the point) to out, or 0 when outside.
 */
export function pointInVehicle(v, px, pz, r, out) {
  const dx = px - v.position.x, dz = pz - v.position.z;
  const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
  const lf = dx * s + dz * c, lr = -dx * c + dz * s;
  const hw = v.def.size.w / 2 + r, hl = v.def.size.l / 2 + r;
  if (Math.abs(lf) >= hl || Math.abs(lr) >= hw) return 0;
  const pf = hl - Math.abs(lf), pr = hw - Math.abs(lr);
  if (pr < pf) { const k = lr >= 0 ? 1 : -1; out.nx = -c * k; out.nz = s * k; out.pen = pr; }
  else { const k = lf >= 0 ? 1 : -1; out.nx = s * k; out.nz = c * k; out.pen = pf; }
  return out.pen;
}
