// Vehicle type catalogue (VEHICLE_TYPES) + small pure helpers. Owned by the VEHICLES agent.
//
// Every def: name, kind ('car'|'bike'|'heli'), size {w, h, l} (metres), mass (kg), maxSpeed (m/s), accel (m/s^2 at
// low speed), brake (m/s^2), steer (max front-wheel angle, rad; heli: yaw rate rad/s), grip (lateral grip rate 1/s),
// health, colors[] (paint palette, 0xRRGGBB), camDistance, camHeight, seats, siren (bool), price ($),
// plus tuning extras used by the physics/model code (wheel layout, reverse speed, armor, engine sound kind...).
//
// Pure data: importable from Node for unit tests.

const W = (x, z, r, w, opts = {}) => ({ x, z, r, w, steer: !!opts.steer, drive: opts.drive !== false, rear: !!opts.rear });

/** Four-wheel layout helper: track = wheel centre x offset, zf/zr = front/rear axle z. */
function quad(track, zf, zr, r, w, extraRear = null) {
  const out = [
    W(track, zf, r, w, { steer: true, drive: false }), W(-track, zf, r, w, { steer: true, drive: false }),
    W(track, zr, r, w, { rear: true }), W(-track, zr, r, w, { rear: true }),
  ];
  if (extraRear !== null) { out.push(W(track, extraRear, r, w, { rear: true }), W(-track, extraRear, r, w, { rear: true })); }
  return out;
}

export const VEHICLE_TYPES = {
  sedan: {
    name: 'Vapor Sedan', kind: 'car', model: 'sedan', size: { w: 2.0, h: 1.5, l: 4.4 },
    mass: 1400, maxSpeed: 38, accel: 9.5, brake: 19, steer: 0.62, grip: 9.0, health: 600,
    colors: [0xb8bec6, 0x23345e, 0x6e1f26, 0xe9e9e4, 0x1c1d21, 0x2f5b3a, 0xc9b48c, 0x4d7fa8, 0x8a8f96],
    camDistance: 6.8, camHeight: 2.4, seats: 4, siren: false, price: 12000,
    wheels: quad(0.86, 1.36, -1.36, 0.36, 0.26), reverseSpeed: 10, engine: 'car', drift: 1.0,
  },
  sports: {
    name: 'Pixel GT', kind: 'car', model: 'sports', size: { w: 2.0, h: 1.2, l: 4.4 },
    mass: 1250, maxSpeed: 50, accel: 14, brake: 23, steer: 0.6, grip: 10.5, health: 520,
    colors: [0xd0201c, 0xf4c20d, 0xf26b0f, 0x1f5fd6, 0x8fd61a, 0xf2f2f2, 0x161616, 0x7b2ad0],
    camDistance: 6.6, camHeight: 2.15, seats: 2, siren: false, price: 85000,
    wheels: quad(0.85, 1.38, -1.34, 0.36, 0.3), reverseSpeed: 11, engine: 'car', drift: 1.05,
  },
  supercar: {
    name: 'Voxeltron X', kind: 'car', model: 'supercar', size: { w: 2.1, h: 1.1, l: 4.6 },
    mass: 1300, maxSpeed: 58, accel: 16.5, brake: 25, steer: 0.58, grip: 11.5, health: 560,
    colors: [0xff7a00, 0x9be31c, 0x6b1fd1, 0xe8141e, 0xf5f5f5, 0x111111, 0x16b7c9, 0xffd400],
    camDistance: 6.8, camHeight: 2.05, seats: 2, siren: false, price: 240000,
    wheels: quad(0.9, 1.45, -1.42, 0.37, 0.32), reverseSpeed: 11, engine: 'car', drift: 1.0,
  },
  muscle: {
    name: 'Cubic Thunder', kind: 'car', model: 'muscle', size: { w: 2.0, h: 1.4, l: 4.8 },
    mass: 1600, maxSpeed: 46, accel: 13, brake: 17, steer: 0.6, grip: 7.6, health: 700,
    colors: [0x111111, 0xb3121c, 0x1b3fa8, 0x1f6b33, 0xe36a12, 0xdedbd2, 0x5c2a8a],
    camDistance: 7.2, camHeight: 2.35, seats: 2, siren: false, price: 45000,
    wheels: quad(0.85, 1.55, -1.45, 0.38, 0.32), reverseSpeed: 10, engine: 'car', drift: 1.35,
  },
  taxi: {
    name: 'Taxi', kind: 'car', model: 'taxi', size: { w: 2.0, h: 1.5, l: 4.4 },
    mass: 1450, maxSpeed: 37, accel: 9, brake: 19, steer: 0.62, grip: 9.0, health: 620,
    colors: [0xf4c518],
    camDistance: 6.8, camHeight: 2.45, seats: 4, siren: false, price: 15000,
    wheels: quad(0.86, 1.36, -1.36, 0.36, 0.26), reverseSpeed: 10, engine: 'car', drift: 1.0,
  },
  police: {
    name: 'Police Cruiser', kind: 'car', model: 'police', size: { w: 2.0, h: 1.5, l: 4.6 },
    mass: 1600, maxSpeed: 46, accel: 12.5, brake: 22, steer: 0.62, grip: 10.2, health: 800,
    colors: [0x15171c],
    camDistance: 7.0, camHeight: 2.45, seats: 4, siren: true, price: 30000, police: true,
    wheels: quad(0.86, 1.45, -1.42, 0.37, 0.27), reverseSpeed: 11, engine: 'car', drift: 1.0,
  },
  van: {
    name: 'Boxer Van', kind: 'car', model: 'van', size: { w: 2.2, h: 2.4, l: 5.0 },
    mass: 2400, maxSpeed: 30, accel: 7, brake: 15, steer: 0.58, grip: 8.0, health: 800,
    colors: [0xeeeeea, 0x8b9096, 0x8fb7d6, 0x6b4f35, 0x2d4f7a, 0xc23a2a],
    camDistance: 8.4, camHeight: 3.1, seats: 2, siren: false, price: 22000,
    wheels: quad(0.95, 1.62, -1.55, 0.4, 0.28), reverseSpeed: 8, engine: 'truck', drift: 0.9,
  },
  truck: {
    name: 'Hauler Truck', kind: 'car', model: 'truck', size: { w: 2.6, h: 3.2, l: 8.0 },
    mass: 7000, maxSpeed: 28, accel: 5, brake: 11, steer: 0.52, grip: 7.5, health: 1400,
    colors: [0xc0221d, 0x1f4fa0, 0xe8e8e2, 0x2f6b2a, 0xe0a512, 0x2a2a2e],
    camDistance: 12.5, camHeight: 4.3, seats: 2, siren: false, price: 60000,
    wheels: quad(1.08, 2.75, -1.75, 0.52, 0.36, -3.0), reverseSpeed: 6, engine: 'truck', drift: 0.8,
  },
  bus: {
    name: 'City Bus', kind: 'car', model: 'bus', size: { w: 2.8, h: 3.4, l: 11.0 },
    mass: 9000, maxSpeed: 24, accel: 4.2, brake: 10, steer: 0.5, grip: 7.5, health: 1600,
    colors: [0x2f8f4e, 0x1f5fb0, 0xd9381e, 0xf0b419],
    camDistance: 14.5, camHeight: 4.7, seats: 24, siren: false, price: 90000,
    wheels: quad(1.18, 3.7, -3.0, 0.55, 0.38), reverseSpeed: 6, engine: 'truck', drift: 0.7,
  },
  pickup: {
    name: 'Rancher Pickup', kind: 'car', model: 'pickup', size: { w: 2.1, h: 1.8, l: 5.2 },
    mass: 2000, maxSpeed: 36, accel: 9, brake: 16, steer: 0.6, grip: 8.5, health: 780,
    colors: [0x7a4a24, 0xa8261f, 0x2b4e8c, 0xe6e4dc, 0x1d1e22, 0x355e2e, 0xb7a27a],
    camDistance: 7.6, camHeight: 2.75, seats: 2, siren: false, price: 18000,
    wheels: quad(0.9, 1.72, -1.68, 0.42, 0.3), reverseSpeed: 10, engine: 'truck', drift: 1.05,
  },
  bike: {
    name: 'Pulse 600', kind: 'bike', model: 'bike', size: { w: 0.8, h: 1.3, l: 2.2 },
    mass: 230, maxSpeed: 52, accel: 15, brake: 20, steer: 0.7, grip: 11, health: 320,
    colors: [0xd51f1f, 0x151515, 0x1d57d6, 0xf07b12, 0x2fb34a, 0xf0f0f0],
    camDistance: 5.2, camHeight: 2.0, seats: 1, siren: false, price: 9000,
    wheels: [W(0, 0.8, 0.33, 0.16, { steer: true, drive: false }), W(0, -0.78, 0.33, 0.2, { rear: true })],
    reverseSpeed: 4, engine: 'bike', drift: 0.8,
  },
  heli: {
    name: 'Skylark Heli', kind: 'heli', model: 'heli', size: { w: 2.4, h: 2.6, l: 8.0 },
    mass: 2800, maxSpeed: 46, accel: 11, brake: 6, steer: 1.45, grip: 1.2, health: 750,
    colors: [0xf2f2ef, 0xc4231c, 0x1c3f8f, 0x1b1b1f, 0xf0b616, 0x2c6e3a],
    camDistance: 13, camHeight: 4.6, seats: 4, siren: false, price: 350000,
    wheels: [], rotorRadius: 5.0, engine: 'heli',
  },
  police_heli: {
    name: 'Police Chopper', kind: 'heli', model: 'police_heli', size: { w: 2.4, h: 2.6, l: 8.0 },
    mass: 3000, maxSpeed: 50, accel: 12, brake: 6, steer: 1.5, grip: 1.2, health: 1000,
    colors: [0x1b2a55],
    camDistance: 13, camHeight: 4.6, seats: 4, siren: true, price: 0, police: true,
    wheels: [], rotorRadius: 5.0, engine: 'heli',
  },
  swat: {
    name: 'SWAT Enforcer', kind: 'car', model: 'swat', size: { w: 2.4, h: 2.6, l: 5.6 },
    mass: 5500, maxSpeed: 34, accel: 7.5, brake: 15, steer: 0.55, grip: 9.0, health: 2000,
    colors: [0x17181b],
    camDistance: 9.0, camHeight: 3.4, seats: 8, siren: true, price: 0, police: true, armor: 0.5,
    wheels: quad(1.02, 1.85, -1.75, 0.5, 0.36), reverseSpeed: 8, engine: 'truck', drift: 0.8,
  },
  ambulance: {
    name: 'Ambulance', kind: 'car', model: 'ambulance', size: { w: 2.3, h: 2.7, l: 5.6 },
    mass: 2900, maxSpeed: 36, accel: 8, brake: 16, steer: 0.58, grip: 8.5, health: 900,
    colors: [0xf2f2ee],
    camDistance: 9.0, camHeight: 3.4, seats: 4, siren: true, price: 0,
    wheels: quad(0.98, 1.85, -1.7, 0.42, 0.3), reverseSpeed: 8, engine: 'truck', drift: 0.85,
  },
};

// Fill derived defaults so every def is complete.
for (const [type, d] of Object.entries(VEHICLE_TYPES)) {
  d.type = type;
  d.isPolice = !!d.police;
  d.armor = d.armor || 0;
  d.reverseSpeed = d.reverseSpeed || 10;
  d.drift = d.drift || 1;
  d.rotorRadius = d.rotorRadius || 0;
  // longest wheelbase between steering and rear axles (bicycle model)
  const ws = d.wheels || [];
  const zf = ws.filter((w) => w.steer).reduce((m, w) => Math.max(m, w.z), -Infinity);
  const zr = ws.filter((w) => !w.steer).reduce((m, w) => Math.min(m, w.z), Infinity);
  d.wheelbase = Number.isFinite(zf) && Number.isFinite(zr) ? Math.max(0.8, zf - zr) : d.size.l * 0.6;
  d.axleF = Number.isFinite(zf) ? zf : d.size.l * 0.3;
  d.axleR = Number.isFinite(zr) ? zr : -d.size.l * 0.3;
  d.wheelRadius = ws.length ? ws[0].r : 0.4;
}

/** Ordered list of type ids. */
export const VEHICLE_TYPE_IDS = Object.keys(VEHICLE_TYPES);

/** Weighted random type for parking spots by spot tag. rng() -> [0,1). */
export function parkedTypeForTag(tag, rng = Math.random) {
  const table = PARK_TABLES[tag] || PARK_TABLES.default;
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rng() * total;
  for (const [t, w] of table) { r -= w; if (r <= 0) return t; }
  return table[0][0];
}

const PARK_TABLES = {
  default: [['sedan', 30], ['sports', 9], ['muscle', 9], ['pickup', 9], ['van', 7], ['taxi', 4], ['supercar', 3], ['bike', 8]],
  lot: [['sedan', 32], ['sports', 10], ['muscle', 9], ['pickup', 9], ['van', 7], ['taxi', 5], ['supercar', 3], ['bike', 7]],
  driveway: [['sedan', 30], ['pickup', 14], ['muscle', 10], ['sports', 8], ['van', 8], ['bike', 6], ['supercar', 2]],
  police: [['police', 1]],
  ambulance: [['ambulance', 1]],
  truck: [['truck', 5], ['van', 4], ['pickup', 2]],
  farm: [['pickup', 1]],
  safehouse: [['sports', 3], ['muscle', 3], ['supercar', 1]],
  garage: [['sedan', 2], ['muscle', 2], ['sports', 2], ['pickup', 1]],
};

/** A paint colour for a type (deterministic when rng is seeded). */
export function pickColor(def, rng = Math.random) {
  const c = def && def.colors && def.colors.length ? def.colors : [0x888888];
  return c[Math.floor(rng() * c.length) % c.length];
}

/** Simulated 5/6-speed gearbox: returns rpm 0..1 for a forward speed (m/s). */
export function gearboxRpm(speed, maxSpeed, throttle, gears = 5) {
  const s = Math.abs(speed);
  if (s < 0.4) return 0.12 + 0.55 * Math.max(0, throttle); // idle / revving in place
  const top = Math.max(1, maxSpeed * 1.04);
  const f = Math.min(1, s / top);
  // gear boundaries: low gears are short
  let lo = 0, hi = 0;
  for (let g = 1; g <= gears; g++) {
    const b = Math.pow(g / gears, 1.25);
    if (f <= b || g === gears) { hi = b; break; }
    lo = b;
  }
  const t = (f - lo) / Math.max(1e-3, hi - lo);
  return Math.min(1, 0.28 + 0.7 * t + 0.04 * Math.max(0, throttle));
}
