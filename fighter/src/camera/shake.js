// Camera shake (trauma model, smooth multi-sine noise) + directional punch (damped spring).
// No allocations: all state is plain numbers.

const noise = (t, a, b, c) => Math.sin(t * a + c) * 0.6 + Math.sin(t * b + c * 1.7) * 0.4;

export class Shake {
  constructor() {
    this.trauma = 0;     // 0..1, offsets scale with trauma²
    this.t = 0;
    this.decay = 2.4;    // trauma per second
    this.maxRot = 0.026; // radians at trauma 1
    this.maxPos = 0.05;  // metres at trauma 1
    // punch spring (world space offset)
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.k = 260; this.c = 2 * Math.sqrt(260) * 0.72;
    // outputs
    this.yaw = 0; this.pitch = 0; this.roll = 0; this.ox = 0; this.oy = 0;
  }

  add(amount) { this.trauma = Math.min(1, this.trauma + Math.max(0, amount)); }

  /** Kick the camera along a world direction (m/s impulse). */
  kick(x, y, z, strength = 1) {
    const l = Math.hypot(x, y, z) || 1;
    const s = 1.5 * strength / l;
    this.vx += x * s; this.vy += y * s; this.vz += z * s;
  }

  clear() { this.trauma = 0; this.px = this.py = this.pz = this.vx = this.vy = this.vz = 0; this.yaw = this.pitch = this.roll = this.ox = this.oy = 0; }

  update(dt) {
    if (dt <= 0) return;
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const s = this.trauma * this.trauma, t = this.t;
    if (s > 0) {
      this.yaw = this.maxRot * s * noise(t, 71, 113, 1.3);
      this.pitch = this.maxRot * s * noise(t, 83, 127, 4.1);
      this.roll = this.maxRot * 0.6 * s * noise(t, 59, 97, 7.7);
      this.ox = this.maxPos * s * noise(t, 67, 109, 2.9);
      this.oy = this.maxPos * s * noise(t, 79, 131, 5.3);
    } else this.yaw = this.pitch = this.roll = this.ox = this.oy = 0;
    // spring (sub-stepped for stability at low frame rates)
    let left = Math.min(dt, 0.1);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      left -= h;
      this.vx += (-this.k * this.px - this.c * this.vx) * h;
      this.vy += (-this.k * this.py - this.c * this.vy) * h;
      this.vz += (-this.k * this.pz - this.c * this.vz) * h;
      this.px += this.vx * h; this.py += this.vy * h; this.pz += this.vz * h;
    }
    const m = Math.hypot(this.px, this.py, this.pz);
    if (m > 0.15) { const k = 0.15 / m; this.px *= k; this.py *= k; this.pz *= k; }
  }
}
