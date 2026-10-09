// Voxel-style vehicle models. Every model faces +Z with its origin at the ground contact centre.
// Local +X is the vehicle's LEFT side (driver side; right-hand traffic), -X its right side.
//
// Per vehicle the renderer uses at most 6 draw calls:
//   body   (merged opaque boxes, vertex colours; geometry cached per type+paint, ref-counted)
//   glass  (shared per type, transparent tinted)
//   lights (per-vehicle copy so colours can change: headlights, tail/brake/reverse, indicators, light bars, signs)
//   wheels (InstancedMesh of one shared wheel geometry)
//   driver (small seated figure, shared geometry per look)
//   rotors (helicopters only; main + tail rotor replace wheels/extra)
import * as THREE from 'three';
import { Spec, bake, flatColored, mergeColored, shadeHex, luminance } from './modelkit.js';
import { VEHICLE_TYPES } from './types.js';

// ------------------------------------------------------------------------------------------------ materials
let MATS = null;
/** Shared materials (created lazily so the module stays importable in Node). */
export function materials() {
  if (MATS) return MATS;
  MATS = {
    body: new THREE.MeshLambertMaterial({ vertexColors: true }),
    glass: new THREE.MeshPhongMaterial({
      color: 0x2a3d4f, specular: 0xb8d2ea, shininess: 90, transparent: true, opacity: 0.58, depthWrite: false,
    }),
    lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
    wheel: new THREE.MeshLambertMaterial({ vertexColors: true }),
    wheelBurnt: new THREE.MeshLambertMaterial({ color: 0x2a2725 }),
    rotor: new THREE.MeshLambertMaterial({ vertexColors: true }),
    skid: new THREE.MeshBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  MATS.glass.name = 'vehicleGlass';
  return MATS;
}

// ------------------------------------------------------------------------------------------------ palette
const FIXED = {
  trim: 0x1f2023, trimL: 0x46484d, chrome: 0xc8ccd0, well: 0x0e0e10, grille: 0x141516, plate: 0xeeeee2, plateT: 0x2a3f78,
  seat: 0x3a302b, dash: 0x232427, interior: 0x2e2b29, tire: 0x161616, gold: 0xd9a82a, white: 0xf2f2ef, black: 0x151516,
  red: 0xc0241c, blue: 0x1d3fa0, yellow: 0xf4c518, boxwhite: 0xe4e4dd, rubber: 0x1a1a1a, metal: 0x8d9196, darkmetal: 0x4b4e53,
  orange: 0xe8741a, green: 0x2c7a3a, checker: 0x111111, cream: 0xe9e2cc, wood: 0x6b4a2c, signBase: 0x202022,
};
const BURNT = { trim: 0x1b1a19, trimL: 0x2b2927, chrome: 0x3d3a37, interior: 0x121110, seat: 0x141312, plate: 0x3a3836, plateT: 0x2a2826, gold: 0x3a342a, white: 0x3b3936, boxwhite: 0x3a3835, cream: 0x34312e };

/** Resolve a colour key for a paint. */
function makeResolver(paint, paint2, burnt) {
  const pd = shadeHex(paint, 0.7);
  return (col) => {
    if (typeof col === 'number') return burnt ? shadeHex(0x2b2826, 0.9 + (col & 15) / 80) : col;
    if (burnt) {
      if (col === 'paint' || col === 'paint2' || col === 'paintD') return col === 'paintD' ? 0x1e1c1b : 0x2c2927;
      return BURNT[col] ?? shadeHex(FIXED[col] ?? 0x333333, 0.35);
    }
    if (col === 'paint') return paint;
    if (col === 'paint2') return paint2;
    if (col === 'paintD') return pd;
    return FIXED[col] ?? 0xff00ff;
  };
}

/** Secondary colour (stripes / two-tone) for a paint. */
export function secondaryFor(type, paint) {
  if (type === 'police') return 0xf2f2ef;
  if (type === 'police_heli') return 0xf2f2ef;
  if (type === 'ambulance') return 0xc8231c;
  if (type === 'taxi') return 0x111111;
  if (type === 'bus') return 0xf0f0ea;
  if (type === 'truck') return 0xe6e6df;
  if (type === 'heli') return luminance(paint) > 0.6 ? 0x1c3f8f : 0xf2f2ef;
  return luminance(paint) > 0.55 ? 0x161616 : 0xf2f2ef;
}

// ------------------------------------------------------------------------------------------------ helpers
/** Hexa whose top surface slopes along z (yTopA at z0, yTopB at z1); x top inset `ins`. */
function wedge(s, layer, x0, x1, z0, z1, y0, yTopA, yTopB, col, ins = 0, role) {
  return s.hexa(layer, [
    x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
    x0 + ins, yTopA, z0, x1 - ins, yTopA, z0, x1 - ins, yTopB, z1, x0 + ins, yTopB, z1,
  ], col, role);
}

/**
 * Lower body with wheel arches. o: {w, track, ww, zN, zT, y0, y1, arches:[{z,r}], col, flare, sill}
 * A dark core lines the wheel wells; painted outer panels fill between the arches.
 */
function lowerBody(s, o) {
  const hw = o.w / 2;
  const inner = Math.min(hw - 0.12, o.track - o.ww / 2 - 0.03);
  const col = o.col || 'paint';
  s.box('b', -inner, o.y0, o.zT + 0.04, inner, o.y1 - 0.005, o.zN - 0.04, 'well');
  const zones = o.arches.map((a) => ({ z0: a.z - a.r - 0.1, z1: a.z + a.r + 0.1, top: 2 * a.r + 0.07 })).sort((a, b) => a.z0 - b.z0);
  let cur = o.zT;
  const seg = (z0, z1) => {
    if (z1 - z0 < 0.01) return;
    const atEnd = z0 <= o.zT + 1e-6 || z1 >= o.zN - 1e-6;
    const y0 = o.y0 + (atEnd ? 0.04 : 0);
    if (atEnd) s.box('b', -hw, y0, z0, hw, o.y1, z1, col);
    else {
      s.pair('b', inner, y0, z0, hw, o.y1, z1, col);
      if (o.sill !== false) s.pair('b', hw - 0.005, o.y0, z0 + 0.02, hw + 0.015, o.y0 + 0.1, z1 - 0.02, 'trim');
    }
  };
  for (const zn of zones) {
    seg(cur, zn.z0);
    if (zn.top < o.y1 - 0.02) s.pair('b', inner, zn.top, zn.z0, hw, o.y1, zn.z1, col);
    else {
      const f = o.flare || 0;
      s.pair('b', inner, o.y1 - 0.08, zn.z0, hw + f, zn.top + 0.03, zn.z1, col);
      s.pair('b', hw + f - 0.002, zn.top - 0.02, zn.z0 + 0.04, hw + f + 0.01, zn.top + 0.035, zn.z1 - 0.04, 'trim'); // arch lip
    }
    cur = zn.z1;
  }
  seg(cur, o.zN);
}

/** Cabin: glass greenhouse + roof slab + A/B/C pillars. c: {zb0, zb1, zt0, zt1, xb, xt, y0, y1, roofT, bz?, cw?} */
function cabin(s, c, col = 'paint') {
  s.taper('g', [-c.xb, c.xb, c.zb0, c.zb1], c.y0, [-c.xt, c.xt, c.zt0, c.zt1], c.y1);
  const rt = c.roofT ?? 0.06;
  s.taper('b', [-c.xt - 0.025, c.xt + 0.025, c.zt0 - 0.035, c.zt1 + 0.035], c.y1 - rt * 0.6, [-c.xt + 0.02, c.xt - 0.02, c.zt0, c.zt1], c.y1 + rt * 0.4, col);
  const pw = c.pw ?? 0.09;      // pillar thickness (x)
  const ad = c.ad ?? 0.13;      // A-pillar depth (z)
  const pillar = (zb0, zb1, zt0, zt1) => {
    const c8 = [
      c.xb - pw + 0.015, c.y0, zb0, c.xb + 0.015, c.y0, zb0, c.xb + 0.015, c.y0, zb1, c.xb - pw + 0.015, c.y0, zb1,
      c.xt - pw + 0.015, c.y1, zt0, c.xt + 0.015, c.y1, zt0, c.xt + 0.015, c.y1, zt1, c.xt - pw + 0.015, c.y1, zt1,
    ];
    s.hexa('b', c8, col);
    s.mirrorHexa('b', c8, col);
  };
  pillar(c.zb1 - ad, c.zb1 + 0.012, c.zt1 - ad, c.zt1 + 0.012);                 // A
  if (c.bz !== undefined) pillar(c.bz - 0.06, c.bz + 0.06, c.bz - 0.06, c.bz + 0.06); // B
  const cw = c.cw ?? 0.2;
  pillar(c.zb0 - 0.012, c.zb0 + cw, c.zt0 - 0.012, c.zt0 + cw * 0.8);            // C
}

/** Interior visible through the glass: dashboard, steering wheel, seats. */
function interior(s, o) {
  const { xb, zDash, zSeat, y0, rows = 1, hw } = o;
  s.box('b', -xb + 0.05, y0 - 0.02, zDash - 0.22, xb - 0.05, y0 + 0.12, zDash, 'dash');
  s.box('b', 0.32, y0 + 0.05, zDash - 0.36, 0.58, y0 + 0.28, zDash - 0.3, 'trim'); // steering wheel (driver = +x)
  const sw = Math.min(0.32, hw * 0.33);
  for (let r = 0; r < rows; r++) {
    const z = zSeat - r * 0.85;
    s.pair('b', 0.12, y0 - 0.25, z - 0.12, 0.12 + sw * 2, y0 + 0.02, z + 0.3, 'seat');      // cushion
    s.pair('b', 0.12, y0 - 0.1, z - 0.2, 0.12 + sw * 2, y0 + 0.5, z - 0.08, 'seat');       // backrest
  }
}

/** Number plate (front or rear face at z, facing dir). */
function plate(s, z, dir, y, w = 0.26) {
  s.box('b', -w, y, z, w, y + 0.13, z + 0.018 * dir, 'plate');
  s.box('b', -w + 0.03, y + 0.035, z + 0.019 * dir, w - 0.03, y + 0.07, z + 0.026 * dir, 'plateT');
}

/** Side mirrors at z, y (on both sides at half-width hw). */
function mirrors(s, hw, z, y, col = 'paint') {
  s.pair('b', hw - 0.04, y, z - 0.08, hw + 0.17, y + 0.12, z + 0.06, col);
  s.pair('b', hw + 0.02, y + 0.015, z - 0.085, hw + 0.15, y + 0.105, z - 0.075, 0x9fb6c8);
}

/** Door seams (vertical dark lines) + handles on both sides. */
function doors(s, hw, seams, yA, yB, handles, hy) {
  for (const z of seams) s.pair('b', hw - 0.004, yA, z - 0.012, hw + 0.006, yB, z + 0.012, 'trim');
  for (const z of handles || []) s.pair('b', hw - 0.004, hy, z - 0.07, hw + 0.022, hy + 0.035, z + 0.07, 'chrome');
}

// ------------------------------------------------------------------------------------------------ cars
/** Generic three-box passenger car used by sedan/taxi/police/sports/supercar/muscle with per-model parameters. */
function threeBox(s, P) {
  const hw = P.w / 2, zN = P.l / 2, zT = -P.l / 2;
  lowerBody(s, { w: P.w, track: P.track, ww: P.ww, zN, zT, y0: P.y0, y1: P.belt, arches: [{ z: P.zF, r: P.r }, { z: P.zR, r: P.r }], flare: P.flare || 0 });
  // hood (slopes down to the nose), beltline under the cabin, trunk deck
  const cz1 = P.cab.zb1, cz0 = P.cab.zb0;
  wedge(s, 'b', -hw, hw, cz1 - 0.02, zN, P.belt, P.hoodY0, P.hoodY1, P.hoodCol || 'paint', 0.035);
  s.box('b', -hw, P.belt, cz0, hw, P.cab.y0, cz1, 'paint');
  wedge(s, 'b', -hw, hw, zT, cz0 + 0.02, P.belt, P.trunkY1, P.trunkY0, P.trunkCol || 'paint', 0.035);
  cabin(s, P.cab, P.roofCol || 'paint');
  interior(s, { xb: P.cab.xb, zDash: cz1, zSeat: P.seatZ ?? (cz1 - 0.75), y0: P.cab.y0, rows: P.rows || 1, hw });
  // front: bumper, grille, lights, plate
  const by0 = P.bumperY0 ?? P.y0 + 0.02, by1 = P.bumperY1 ?? P.y0 + 0.24;
  s.box('b', -hw + 0.02, by0, zN - 0.04, hw - 0.02, by1, zN + 0.09, P.bumperCol || 'trimL');
  s.box('b', -hw + 0.02, by0, zT - 0.09, hw - 0.02, by1, zT + 0.04, P.bumperCol || 'trimL');
  const gw = P.grilleW ?? 0.5;
  if (gw > 0) {
    const gy0 = P.grilleY0 ?? by1 + 0.02, gy1 = P.grilleY1 ?? Math.min(P.hoodY1 - 0.04, gy0 + 0.2);
    s.box('b', -gw, gy0, zN - 0.02, gw, gy1, zN + 0.025, 'grille');
    const slats = P.slats ?? 2;
    for (let i = 1; i <= slats; i++) {
      const y = gy0 + ((gy1 - gy0) * i) / (slats + 1);
      s.box('b', -gw + 0.02, y - 0.012, zN + 0.02, gw - 0.02, y + 0.012, zN + 0.035, P.slatCol || 'chrome');
    }
  }
  const L = P.lights;
  s.pair('l', L.hx0, L.hy0, zN - 0.02, L.hx1, L.hy1, zN + 0.035, 0, 'head');
  if (L.ind !== false) s.pair('l', L.hx1 + 0.01, L.hy0, zN - 0.03, Math.min(hw - 0.015, L.hx1 + 0.08), L.hy0 + (L.hy1 - L.hy0) * 0.6, zN + 0.03, 0, 'ind');
  if (L.tailBar) {
    s.box('l', -L.tx1, L.ty0, zT - 0.035, L.tx1, L.ty1, zT + 0.02, 0, 'tail');
  } else {
    s.pair('l', L.tx0, L.ty0, zT - 0.035, L.tx1, L.ty1, zT + 0.02, 0, 'tail');
    s.pair('l', Math.max(0.2, L.tx0 - 0.13), L.ty0, zT - 0.03, L.tx0 - 0.01, L.ty0 + (L.ty1 - L.ty0) * 0.55, zT + 0.02, 0, 'rev');
  }
  plate(s, zN + 0.09, 1, by0 + 0.04);
  plate(s, zT - 0.03, -1, P.rearPlateY ?? L.ty0 - 0.02);
  mirrors(s, hw, cz1 - 0.12, P.cab.y0 + 0.02, P.mirrorCol || 'paint');
  doors(s, hw, P.seams, P.y0 + 0.08, P.cab.y0 - 0.005, P.handles, P.cab.y0 - 0.12);
  // exhaust
  s.box('b', -0.72, P.y0 + 0.02, zT - 0.12, -0.56, P.y0 + 0.11, zT + 0.1, 'chrome');
  s.box('b', -0.7, P.y0 + 0.035, zT - 0.125, -0.58, P.y0 + 0.095, zT - 0.115, 'black');
  s.meta.driver = { x: 0.42, y: P.cab.y0 - 0.32, z: cz1 - 0.72 };
  s.meta.engine = { x: 0, y: P.hoodY0, z: (cz1 + zN) / 2 };
  s.meta.exhaust = { x: -0.64, y: P.y0 + 0.07, z: zT - 0.15 };
}

function sedanParams(l = 4.4) {
  const k = (l - 4.4) / 2;
  return {
    w: 2.0, l, r: 0.36, ww: 0.26, track: 0.86, zF: 1.36 + k * 0.6, zR: -1.36 - k * 0.6, y0: 0.27, belt: 0.79,
    hoodY0: 0.93, hoodY1: 0.85, trunkY0: 0.93, trunkY1: 0.9,
    cab: { zb0: -1.3 - k * 0.3, zb1: 0.68 + k * 0.2, zt0: -0.94 - k * 0.3, zt1: 0.16 + k * 0.2, xb: 0.94, xt: 0.8, y0: 0.93, y1: 1.47, roofT: 0.06, bz: -0.3, cw: 0.24 },
    rows: 2, seatZ: -0.1,
    lights: { hx0: 0.56, hx1: 0.9, hy0: 0.6, hy1: 0.76, tx0: 0.56, tx1: 0.95, ty0: 0.62, ty1: 0.8 },
    seams: [0.68 + k * 0.2, -0.3, -1.25 - k * 0.3], handles: [0.3, -0.62], grilleW: 0.5, rows2: true,
  };
}

function buildSedan(s, variant) {
  const P = sedanParams(variant === 'police' ? 4.6 : 4.4);
  if (variant === 'police') {
    P.bumperCol = 'black';
    P.roofCol = 'paint2';
    P.track = 0.86; P.zF = 1.45; P.zR = -1.42;
  }
  threeBox(s, P);
  const hw = 1.0, zN = P.l / 2;
  if (variant === 'taxi') {
    // roof sign + checker stripe along the doors
    s.box('b', -0.36, 1.49, -0.44, 0.36, 1.53, -0.2, 'signBase');
    s.box('l', -0.34, 1.53, -0.42, 0.34, 1.72, -0.22, 0, 'sign');
    for (const side of [1, -1]) {
      for (let i = 0; i < 14; i++) {
        const z0 = -1.2 + i * 0.13;
        for (let row = 0; row < 2; row++) {
          if ((i + row) % 2) continue;
          const y = 0.6 + row * 0.07;
          if (side > 0) s.box('b', hw - 0.002, y, z0, hw + 0.008, y + 0.07, z0 + 0.13, 'checker');
          else s.box('b', -hw - 0.008, y, z0, -hw + 0.002, y + 0.07, z0 + 0.13, 'checker');
        }
      }
    }
  }
  if (variant === 'police') {
    // white doors (two-tone), gold star badge, light bar, push bar, spotlight
    s.pair('b', hw - 0.002, 0.4, -1.32, hw + 0.006, 0.93, 0.74, 'paint2');
    s.pair('b', hw + 0.006, 0.56, -0.12, hw + 0.012, 0.74, 0.06, 'gold');
    s.pair('b', hw + 0.006, 0.62, -0.06, hw + 0.016, 0.68, 0.0, 'paint');
    s.box('b', -0.74, 1.5, -0.42, 0.74, 1.56, -0.16, 'signBase');
    s.box('l', 0.06, 1.56, -0.41, 0.72, 1.68, -0.17, 0, 'barR');
    s.box('l', -0.72, 1.56, -0.41, -0.06, 1.68, -0.17, 0, 'barB');
    s.box('l', -0.06, 1.56, -0.36, 0.06, 1.64, -0.22, 0, 'barW');
    s.box('b', -0.5, 0.3, zN + 0.09, 0.5, 0.36, zN + 0.2, 'black');
    s.box('b', -0.5, 0.56, zN + 0.09, 0.5, 0.62, zN + 0.2, 'black');
    s.pair('b', 0.32, 0.28, zN + 0.09, 0.42, 0.72, zN + 0.21, 'black');
    s.box('b', 0.9, 0.95, 0.5, 1.02, 1.05, 0.66, 'chrome');
    s.pair('l', 0.12, 0.66, zN + 0.2, 0.24, 0.72, zN + 0.215, 0, 'barR', 'barB'); // grille strobes
  }
}

function buildSports(s) {
  const P = {
    w: 2.0, l: 4.4, r: 0.36, ww: 0.3, track: 0.85, zF: 1.38, zR: -1.34, y0: 0.22, belt: 0.66, flare: 0.04,
    hoodY0: 0.78, hoodY1: 0.62, trunkY0: 0.8, trunkY1: 0.78,
    cab: { zb0: -1.12, zb1: 0.5, zt0: -0.72, zt1: -0.18, xb: 0.92, xt: 0.74, y0: 0.78, y1: 1.18, roofT: 0.05, ad: 0.12, cw: 0.3 },
    rows: 1, seatZ: -0.2,
    lights: { hx0: 0.5, hx1: 0.92, hy0: 0.52, hy1: 0.6, tx0: 0.4, tx1: 0.93, ty0: 0.6, ty1: 0.68, tailBar: true },
    seams: [0.5, -0.82], handles: [-0.55], grilleW: 0.62, grilleY0: 0.27, grilleY1: 0.46, slats: 3, slatCol: 'trimL',
    bumperY0: 0.22, bumperY1: 0.3, rearPlateY: 0.4, bumperCol: 'paintD',
  };
  threeBox(s, P);
  const hw = 1.0;
  // spoiler
  s.pair('b', 0.52, 0.8, -2.08, 0.6, 1.02, -1.92, 'trim');
  s.box('b', -0.95, 1.0, -2.2, 0.95, 1.05, -1.86, 'paint');
  s.pair('b', 0.93, 0.9, -2.22, 0.97, 1.1, -1.84, 'paint');
  // side intakes + hood vents + splitter + diffuser
  s.pair('b', hw - 0.004, 0.36, -1.0, hw + 0.012, 0.58, -0.66, 'grille');
  s.pair('b', 0.18, 0.79, 1.0, 0.42, 0.805, 1.5, 'trim');
  s.box('b', -0.98, 0.18, 2.16, 0.98, 0.22, 2.36, 'trim');
  for (let i = -2; i <= 2; i++) s.box('b', i * 0.3 - 0.02, 0.18, -2.3, i * 0.3 + 0.02, 0.36, -2.12, 'trim');
  s.pair('b', 0.1, 0.27, -2.32, 0.24, 0.35, -2.18, 'chrome');
}

function buildSupercar(s) {
  const P = {
    w: 2.1, l: 4.6, r: 0.37, ww: 0.32, track: 0.9, zF: 1.45, zR: -1.42, y0: 0.2, belt: 0.6, flare: 0.06,
    hoodY0: 0.72, hoodY1: 0.46, trunkY0: 0.86, trunkY1: 0.76,
    cab: { zb0: -0.92, zb1: 0.72, zt0: -0.58, zt1: -0.08, xb: 0.9, xt: 0.62, y0: 0.72, y1: 1.08, roofT: 0.05, ad: 0.11, cw: 0.36 },
    rows: 1, seatZ: -0.15,
    lights: { hx0: 0.48, hx1: 0.94, hy0: 0.44, hy1: 0.5, tx0: 0.4, tx1: 0.98, ty0: 0.64, ty1: 0.7, tailBar: true },
    seams: [0.72, -0.85], handles: [], grilleW: 0.7, grilleY0: 0.24, grilleY1: 0.4, slats: 2, slatCol: 'trimL',
    bumperY0: 0.2, bumperY1: 0.27, rearPlateY: 0.42, bumperCol: 'paintD', mirrorCol: 'trim',
  };
  threeBox(s, P);
  const hw = 1.05;
  // engine cover slats behind the canopy, big wing, intakes, diffuser
  for (let i = 0; i < 4; i++) s.box('b', -0.5, 0.86, -1.1 - i * 0.22, 0.5, 0.88, -1.0 - i * 0.22, 'trim');
  s.pair('b', 0.45, 0.86, -2.18, 0.53, 1.12, -2.02, 'trim');
  s.box('b', -1.02, 1.1, -2.32, 1.02, 1.15, -1.96, 'paint');
  s.pair('b', 1.0, 0.98, -2.34, 1.05, 1.2, -1.94, 'paint');
  s.pair('b', hw - 0.004, 0.3, -1.05, hw + 0.012, 0.6, -0.5, 'grille');
  s.pair('b', hw - 0.03, 0.62, -0.95, hw + 0.01, 0.74, -0.55, 'paintD');
  s.box('b', -1.02, 0.16, 2.24, 1.02, 0.2, 2.44, 'trim');
  for (let i = -3; i <= 3; i++) s.box('b', i * 0.25 - 0.02, 0.16, -2.42, i * 0.25 + 0.02, 0.4, -2.2, 'trim');
  s.box('b', -0.3, 0.3, -2.42, 0.3, 0.42, -2.3, 'chrome');
  s.box('b', -0.24, 0.32, -2.425, 0.24, 0.4, -2.41, 'black');
  // stripe on the nose
  s.box('b', -0.12, 0.465, 1.0, 0.12, 0.72, 2.31, 'paint2');
}

function buildMuscle(s) {
  const P = {
    w: 2.0, l: 4.8, r: 0.38, ww: 0.32, track: 0.85, zF: 1.55, zR: -1.45, y0: 0.27, belt: 0.78,
    hoodY0: 0.94, hoodY1: 0.9, trunkY0: 0.94, trunkY1: 0.95,
    cab: { zb0: -1.42, zb1: 0.32, zt0: -1.1, zt1: -0.12, xb: 0.94, xt: 0.82, y0: 0.94, y1: 1.38, roofT: 0.06, cw: 0.32 },
    rows: 1, seatZ: -0.35,
    lights: { hx0: 0.5, hx1: 0.88, hy0: 0.64, hy1: 0.78, tx0: 0.3, tx1: 0.95, ty0: 0.7, ty1: 0.82, ind: false },
    seams: [0.32, -1.1], handles: [-0.85], grilleW: 0.95, grilleY0: 0.58, grilleY1: 0.84, slats: 3, slatCol: 'darkmetal',
    bumperCol: 'chrome', bumperY0: 0.3, bumperY1: 0.46,
  };
  threeBox(s, P);
  // hood scoop, racing stripes, ducktail, side pipes, round-ish quad headlights frame
  s.box('b', -0.3, 0.94, 0.7, 0.3, 1.04, 1.5, 'paint');
  s.box('b', -0.24, 0.96, 1.5, 0.24, 1.02, 1.52, 'black');
  for (const x of [0.12, -0.3]) {
    s.box('b', x, 0.905, 0.33, x + 0.18, 0.96, 2.39, 'paint2');
    s.box('b', x, 1.38, -1.11, x + 0.18, 1.43, -0.11, 'paint2');
    s.box('b', x, 0.945, -2.39, x + 0.18, 0.99, -1.41, 'paint2');
  }
  s.box('b', -0.98, 0.95, -2.42, 0.98, 1.04, -2.3, 'paint');
  s.pair('b', 1.0, 0.3, -0.9, 1.07, 0.37, 0.4, 'chrome');
  s.pair('b', 0.49, 0.62, 2.39, 0.51, 0.8, 2.43, 'chrome');
  s.pair('b', 0.69, 0.62, 2.39, 0.71, 0.8, 2.43, 'chrome');
}

function buildPickup(s) {
  const hw = 1.05, zN = 2.6, zT = -2.6;
  lowerBody(s, { w: 2.1, track: 0.9, ww: 0.3, zN, zT, y0: 0.38, y1: 0.98, arches: [{ z: 1.72, r: 0.42 }, { z: -1.68, r: 0.42 }], flare: 0.05 });
  // hood + cab
  wedge(s, 'b', -hw, hw, 0.75, zN, 0.98, 1.2, 1.14, 'paint', 0.03);
  s.box('b', -hw, 0.98, -0.62, hw, 1.2, 0.78, 'paint');
  cabin(s, { zb0: -0.6, zb1: 0.76, zt0: -0.56, zt1: 0.3, xb: 0.98, xt: 0.88, y0: 1.2, y1: 1.78, roofT: 0.07, bz: -0.02, cw: 0.16 });
  interior(s, { xb: 0.98, zDash: 0.76, zSeat: 0.05, y0: 1.2, rows: 1, hw });
  // bed
  s.box('b', -hw, 0.98, zT, hw, 1.0, -0.64, 'trim');
  s.pair('b', hw - 0.1, 1.0, zT + 0.05, hw, 1.32, -0.64, 'paint');
  s.box('b', -hw, 1.0, -0.7, hw, 1.32, -0.62, 'paint');
  s.box('b', -hw, 0.62, zT - 0.02, hw, 1.32, zT + 0.08, 'paint');
  s.box('b', -0.5, 1.0, zT - 0.03, 0.5, 1.1, zT - 0.01, 'trim');
  s.box('b', -0.9, 1.0, -2.3, 0.9, 1.06, -0.75, 'darkmetal');
  // toolbox
  s.box('b', -0.95, 1.32, -0.95, 0.95, 1.42, -0.7, 'chrome');
  // front: big chrome grille, bumper, lights
  s.box('b', -1.02, 0.42, zN - 0.04, 1.02, 0.66, zN + 0.12, 'chrome');
  s.box('b', -1.02, 0.42, zT - 0.12, 1.02, 0.64, zT + 0.02, 'chrome');
  s.box('b', -0.62, 0.7, zN - 0.02, 0.62, 1.1, zN + 0.03, 'grille');
  for (let i = 1; i <= 3; i++) s.box('b', -0.6, 0.7 + i * 0.1 - 0.015, zN + 0.025, 0.6, 0.7 + i * 0.1 + 0.015, zN + 0.04, 'chrome');
  s.pair('b', -0.02, 0.7, zN + 0.025, 0.02, 1.1, zN + 0.04, 'chrome');
  s.pair('l', 0.66, 0.86, zN - 0.02, 0.98, 1.06, zN + 0.035, 0, 'head');
  s.pair('l', 0.66, 0.76, zN - 0.02, 0.98, 0.84, zN + 0.03, 0, 'ind');
  s.pair('l', 0.82, 0.86, zT - 0.12, 1.0, 1.24, zT - 0.02, 0, 'tail');
  s.pair('l', 0.82, 0.74, zT - 0.12, 1.0, 0.84, zT - 0.02, 0, 'rev');
  plate(s, zN + 0.12, 1, 0.47);
  plate(s, zT - 0.02, -1, 0.7);
  mirrors(s, hw, 0.62, 1.22, 'trim');
  doors(s, hw, [0.76, -0.6], 0.48, 1.2, [-0.38], 1.08);
  // running boards
  s.pair('b', hw - 0.02, 0.4, -1.15, hw + 0.12, 0.46, 1.2, 'trim');
  s.meta.driver = { x: 0.42, y: 0.88, z: 0.02 };
  s.meta.engine = { x: 0, y: 1.17, z: 1.7 };
  s.meta.exhaust = { x: -0.7, y: 0.42, z: zT - 0.1 };
  s.box('b', -0.78, 0.4, zT - 0.14, -0.62, 0.48, zT + 0.3, 'chrome');
}

/** Box van body shared by van / ambulance / swat. */
function buildVan(s, variant) {
  const ambo = variant === 'ambulance', swat = variant === 'swat';
  const w = ambo ? 2.3 : swat ? 2.4 : 2.2, l = ambo || swat ? 5.6 : 5.0;
  const hw = w / 2, zN = l / 2, zT = -l / 2;
  const r = swat ? 0.5 : ambo ? 0.42 : 0.4, track = swat ? 1.02 : ambo ? 0.98 : 0.95;
  const zF = swat ? 1.85 : ambo ? 1.85 : 1.62, zR = swat ? -1.75 : ambo ? -1.7 : -1.55;
  const y0 = swat ? 0.42 : 0.32, belt = swat ? 1.18 : 1.02;
  const H = swat ? 2.58 : ambo ? 2.68 : 2.38;
  lowerBody(s, { w, track, ww: swat ? 0.36 : 0.28, zN, zT, y0, y1: belt, arches: [{ z: zF, r }, { z: zR, r }], flare: swat ? 0.04 : 0 });
  const cabZ = zN - (swat ? 1.55 : 1.45);  // windshield base z
  // hood (short, sloped)
  wedge(s, 'b', -hw, hw, cabZ, zN, belt, belt + 0.3, belt + 0.14, 'paint', 0.04);
  // cab glass (windshield + side windows) and roof
  const cabTop = swat ? 2.25 : 2.12;
  const winY0 = belt + 0.3;
  s.taper('g', [-hw + 0.03, hw - 0.03, cabZ - 0.95, cabZ + 0.02], winY0, [-hw + 0.06, hw - 0.06, cabZ - 0.95, cabZ - 0.4], cabTop);
  // pillars around the windshield
  const ap = [hw - 0.1, winY0, cabZ - 0.1, hw + 0.01, winY0, cabZ - 0.1, hw + 0.01, winY0, cabZ + 0.04, hw - 0.1, winY0, cabZ + 0.04,
    hw - 0.12, cabTop, cabZ - 0.52, hw - 0.01, cabTop, cabZ - 0.52, hw - 0.01, cabTop, cabZ - 0.38, hw - 0.12, cabTop, cabZ - 0.38];
  s.hexa('b', ap, 'paint'); s.mirrorHexa('b', ap, 'paint');
  // body sides behind the cab windows
  s.box('b', -hw, belt, cabZ - 0.98, hw, winY0, cabZ, 'paint');
  // cargo box
  const boxW = ambo ? hw + 0.06 : hw;
  const boxZ1 = cabZ - 0.95;
  s.box('b', -boxW, belt - (ambo ? 0.55 : 0), zT, boxW, H, boxZ1, ambo ? 'boxwhite' : 'paint');
  s.box('b', -hw, cabTop - 0.02, boxZ1, hw, H, cabZ - 0.36, ambo ? 'boxwhite' : 'paint');
  if (!ambo) s.box('b', -hw, cabTop - 0.02, cabZ - 0.42, hw, cabTop + 0.06, cabZ - 0.36, 'paint');
  interior(s, { xb: hw - 0.05, zDash: cabZ, zSeat: cabZ - 0.62, y0: winY0 - 0.02, rows: 1, hw });
  // bumpers, grille, lights
  s.box('b', -hw + 0.02, y0 + 0.02, zN - 0.04, hw - 0.02, y0 + 0.28, zN + 0.1, swat ? 'black' : 'trimL');
  s.box('b', -hw + 0.02, y0 + 0.02, zT - 0.1, hw - 0.02, y0 + 0.26, zT + 0.04, swat ? 'black' : 'trimL');
  s.box('b', -0.6, belt - 0.32, zN - 0.02, 0.6, belt + 0.06, zN + 0.025, 'grille');
  for (let i = 1; i <= 2; i++) s.box('b', -0.58, belt - 0.32 + i * 0.13, zN + 0.02, 0.58, belt - 0.3 + i * 0.13, zN + 0.035, swat ? 'darkmetal' : 'chrome');
  s.pair('l', 0.66, belt - 0.24, zN - 0.02, hw - 0.06, belt - 0.06, zN + 0.035, 0, 'head');
  s.pair('l', hw - 0.06, belt - 0.24, zN - 0.03, hw - 0.005, belt - 0.12, zN + 0.03, 0, 'ind');
  s.pair('l', hw - 0.2, belt - 0.2, zT - 0.035, hw - 0.04, belt + 0.25, zT + 0.02, 0, 'tail');
  s.pair('l', hw - 0.2, belt - 0.36, zT - 0.03, hw - 0.04, belt - 0.22, zT + 0.02, 0, 'rev');
  plate(s, zN + 0.1, 1, y0 + 0.07);
  plate(s, zT - 0.03, -1, belt - 0.1);
  mirrors(s, hw, cabZ - 0.12, winY0, 'trim');
  // rear doors seam + small rear windows; side sliding door
  s.box('b', -0.012, y0 + 0.3, zT - 0.006, 0.012, H - 0.12, zT + 0.002, 'trim');
  if (!ambo) s.pair('g', 0.12, H - 0.82, zT - 0.012, hw - 0.18, H - 0.32, zT + 0.005);
  doors(s, ambo ? boxW : hw, [cabZ - 0.95, -0.15, -1.4], y0 + 0.12, H - 0.15, [cabZ - 0.75, -0.3], belt + 0.12);
  s.meta.driver = { x: 0.48, y: winY0 - 0.33, z: cabZ - 0.6 };
  s.meta.engine = { x: 0, y: belt + 0.25, z: (cabZ + zN) / 2 };
  s.meta.exhaust = { x: -0.7, y: y0 + 0.05, z: zT - 0.12 };
  s.box('b', -0.78, y0, zT - 0.15, -0.62, y0 + 0.09, zT + 0.2, 'chrome');

  if (ambo) {
    // red stripe + red cross panels, light bars on the cab roof and the box corners
    s.pair('b', boxW - 0.002, 1.25, zT + 0.05, boxW + 0.008, 1.45, boxZ1 - 0.02, 'paint2');
    s.pair('b', hw - 0.002, 1.25, boxZ1, hw + 0.008, 1.45, zN - 0.3, 'paint2');
    for (const side of [1, -1]) {
      const x0 = side > 0 ? boxW + 0.004 : -boxW - 0.012, x1 = side > 0 ? boxW + 0.012 : -boxW - 0.004;
      s.box('b', x0, 1.75, -1.5, x1, 2.25, -1.35, 'paint2');
      s.box('b', x0, 1.92, -1.68, x1, 2.08, -1.17, 'paint2');
    }
    s.box('b', -0.25, 1.7, zT - 0.012, 0.25, 1.86, zT + 0.002, 'paint2');
    s.box('b', -0.08, 1.53, zT - 0.012, 0.08, 2.03, zT + 0.002, 'paint2');
    s.box('b', -0.7, cabTop + 0.02, cabZ - 0.7, 0.7, cabTop + 0.08, cabZ - 0.45, 'signBase');
    s.box('l', 0.05, cabTop + 0.08, cabZ - 0.68, 0.68, cabTop + 0.18, cabZ - 0.47, 0, 'barR');
    s.box('l', -0.68, cabTop + 0.08, cabZ - 0.68, -0.05, cabTop + 0.18, cabZ - 0.47, 0, 'barW');
    s.pair('l', boxW - 0.18, H, zT + 0.04, boxW - 0.02, H + 0.1, zT + 0.2, 0, 'barR', 'barW');
    s.pair('l', boxW - 0.18, H, boxZ1 - 0.2, boxW - 0.02, H + 0.1, boxZ1 - 0.04, 0, 'barR', 'barW');
  }
  if (swat) {
    // armour: grille guard, slit windows over the glass, roof rails, small light bar
    s.box('b', -0.95, y0 + 0.1, zN + 0.1, 0.95, y0 + 0.2, zN + 0.3, 'darkmetal');
    s.box('b', -0.95, belt - 0.1, zN + 0.1, 0.95, belt, zN + 0.3, 'darkmetal');
    s.pair('b', 0.4, y0 + 0.1, zN + 0.12, 0.5, belt + 0.05, zN + 0.32, 'darkmetal');
    s.pair('b', 0.85, y0 + 0.1, zN + 0.12, 0.95, belt + 0.05, zN + 0.32, 'darkmetal');
    for (let i = 0; i < 3; i++) s.box('b', -hw + 0.04, winY0 + 0.14 + i * 0.22, cabZ - 0.06, hw - 0.04, winY0 + 0.2 + i * 0.22, cabZ + 0.05, 'paint');
    s.pair('b', hw - 0.02, winY0 + 0.25, cabZ - 0.92, hw + 0.01, winY0 + 0.32, cabZ - 0.1, 'paint');
    s.pair('b', hw - 0.25, H, zT + 0.3, hw - 0.15, H + 0.12, boxZ1 - 0.1, 'darkmetal');
    s.pair('b', hw - 0.002, 1.3, zT + 0.2, hw + 0.01, 1.5, boxZ1 - 0.1, 'darkmetal');
    s.box('b', -0.6, cabTop + 0.06, cabZ - 0.62, 0.6, cabTop + 0.1, cabZ - 0.44, 'signBase');
    s.box('l', 0.03, cabTop + 0.1, cabZ - 0.6, 0.58, cabTop + 0.19, cabZ - 0.46, 0, 'barR');
    s.box('l', -0.58, cabTop + 0.1, cabZ - 0.6, -0.03, cabTop + 0.19, cabZ - 0.46, 0, 'barB');
    s.pair('l', 0.14, belt - 0.02, zN + 0.3, 0.3, belt + 0.04, zN + 0.32, 0, 'barR', 'barB');
    // rear step + spare wheel housing
    s.box('b', -0.8, y0, zT - 0.3, 0.8, y0 + 0.06, zT - 0.08, 'darkmetal');
  }
}

function buildTruck(s) {
  const w = 2.6, hw = 1.3, zN = 4.0, zT = -4.0;
  const y0 = 0.5;
  // chassis rails + under-run
  s.pair('b', 0.42, y0 + 0.05, zT + 0.2, 0.62, y0 + 0.35, zN - 0.2, 'trim');
  s.box('b', -1.2, y0 + 0.1, zT - 0.05, 1.2, y0 + 0.3, zT + 0.1, 'darkmetal');
  // cab (front 2 m)
  const cz0 = 1.95;
  lowerBody(s, { w, track: 1.08, ww: 0.36, zN, zT: cz0, y0: y0 + 0.08, y1: 1.4, arches: [{ z: 2.75, r: 0.52 }], sill: false });
  s.box('b', -hw, 1.4, cz0, hw, 1.68, zN, 'paint');
  s.taper('g', [-hw + 0.04, hw - 0.04, cz0 + 0.95, zN - 0.02], 1.68, [-hw + 0.08, hw - 0.08, cz0 + 0.95, zN - 0.12], 2.55);
  s.box('b', -hw, 1.68, cz0, hw, 2.6, cz0 + 0.95, 'paint');
  s.taper('b', [-hw, hw, cz0, zN - 0.1], 2.55, [-hw + 0.05, hw - 0.05, cz0, zN - 0.14], 2.68, 'paint');
  // windshield frame + spoiler on top of the cab
  const fr = [hw - 0.1, 1.68, zN - 0.08, hw + 0.01, 1.68, zN - 0.08, hw + 0.01, 1.68, zN + 0.01, hw - 0.1, 1.68, zN + 0.01,
    hw - 0.12, 2.56, zN - 0.2, hw - 0.02, 2.56, zN - 0.2, hw - 0.02, 2.56, zN - 0.1, hw - 0.12, 2.56, zN - 0.1];
  s.hexa('b', fr, 'paint'); s.mirrorHexa('b', fr, 'paint');
  wedge(s, 'b', -hw + 0.08, hw - 0.08, cz0 + 0.1, cz0 + 1.6, 2.68, 3.15, 2.72, 'paint', 0.05);
  interior(s, { xb: hw - 0.08, zDash: zN - 0.1, zSeat: zN - 0.75, y0: 1.66, rows: 1, hw });
  // big chrome grille, bumper, lights
  s.box('b', -hw + 0.04, y0 + 0.1, zN - 0.04, hw - 0.04, y0 + 0.5, zN + 0.14, 'chrome');
  s.box('b', -0.75, y0 + 0.55, zN - 0.02, 0.75, 1.62, zN + 0.03, 'grille');
  for (let i = 1; i <= 5; i++) s.box('b', -0.73, y0 + 0.55 + i * 0.17 - 0.015, zN + 0.025, 0.73, y0 + 0.55 + i * 0.17 + 0.015, zN + 0.04, 'chrome');
  s.pair('l', 0.82, y0 + 0.62, zN - 0.02, 1.22, y0 + 0.86, zN + 0.035, 0, 'head');
  s.pair('l', 0.82, y0 + 0.88, zN - 0.02, 1.22, y0 + 0.98, zN + 0.03, 0, 'ind');
  s.box('l', -0.5, 2.68, zN - 0.16, 0.5, 2.72, zN - 0.12, 0, 'ind');
  plate(s, zN + 0.14, 1, y0 + 0.2);
  mirrors(s, hw, zN - 0.25, 1.75, 'chrome');
  s.pair('b', hw + 0.1, 1.7, zN - 0.32, hw + 0.16, 2.15, zN - 0.2, 'chrome');
  doors(s, hw, [cz0 + 0.95, zN - 0.15], y0 + 0.3, 2.55, [cz0 + 1.1], 1.55);
  // exhaust stacks behind the cab
  s.pair('b', hw - 0.32, 1.4, cz0 - 0.18, hw - 0.18, 3.3, cz0 - 0.04, 'chrome');
  s.pair('b', hw - 0.33, 3.3, cz0 - 0.19, hw - 0.17, 3.36, cz0 - 0.03, 'black');
  // fuel tanks
  s.pair('b', hw - 0.35, y0 + 0.05, 0.6, hw - 0.02, y0 + 0.45, 1.75, 'chrome');
  // cargo box (light box colour, coloured stripe)
  const bz1 = cz0 - 0.15;
  s.box('b', -hw, 1.0, zT, hw, 3.2, bz1, 'boxwhite');
  s.box('b', -hw, 0.92, zT, hw, 1.0, bz1, 'darkmetal');
  for (let z = zT + 0.6; z < bz1 - 0.2; z += 0.9) s.pair('b', hw - 0.01, 1.0, z - 0.03, hw + 0.012, 3.18, z + 0.03, 0xc8c8c2);
  s.pair('b', hw, 2.2, zT + 0.1, hw + 0.02, 2.5, bz1 - 0.1, 'paint');
  s.box('b', -0.012, 1.05, zT - 0.008, 0.012, 3.15, zT + 0.002, 'trim');
  s.pair('b', 0.55, 1.6, zT - 0.03, 0.62, 2.4, zT + 0.002, 'chrome');
  s.pair('l', 0.95, 0.62, zT - 0.03, 1.25, 0.82, zT + 0.12, 0, 'tail');
  s.pair('l', 0.7, 0.62, zT - 0.03, 0.93, 0.76, zT + 0.12, 0, 'rev');
  s.pair('l', hw - 0.08, 3.16, zT + 0.02, hw - 0.01, 3.22, zT + 0.12, 0, 'ind');
  plate(s, zT - 0.03, -1, 0.66);
  s.box('b', -1.25, 0.55, zT + 0.02, 1.25, 0.6, zT + 0.15, 'darkmetal');
  s.meta.driver = { x: 0.6, y: 1.38, z: zN - 0.72 };
  s.meta.engine = { x: 0, y: 1.7, z: zN - 0.6 };
  s.meta.exhaust = { x: hw - 0.25, y: 3.36, z: cz0 - 0.11, up: true };
}

function buildBus(s) {
  const w = 2.8, hw = 1.4, l = 11, zN = l / 2, zT = -l / 2;
  const y0 = 0.42, H = 3.35;
  lowerBody(s, { w, track: 1.18, ww: 0.38, zN, zT, y0, y1: 1.25, arches: [{ z: 3.7, r: 0.55 }, { z: -3.0, r: 0.55 }], sill: false });
  // side walls below and above the window band, pillars
  const wy0 = 1.55, wy1 = 2.62;
  s.box('b', -hw, 1.25, zT, hw, wy0, zN - 0.15, 'paint');
  s.pair('b', hw - 0.002, 1.32, zT + 0.1, hw + 0.008, 1.45, zN - 0.2, 'paint2');
  s.box('g', -hw + 0.04, wy0, zT + 0.15, hw - 0.04, wy1, zN - 0.2);
  s.box('b', -hw, wy1, zT, hw, H, zN - 0.15, 'paint');
  s.box('b', -hw + 0.1, H, zT + 0.6, hw - 0.1, H + 0.06, zN - 0.6, 'paint2');
  s.box('b', -0.7, H + 0.06, -1.8, 0.7, H + 0.32, 0.2, 'metal');
  for (let z = zT + 0.15; z <= zN - 0.2; z += 1.42) s.pair('b', hw - 0.08, wy0, z - 0.06, hw + 0.004, wy1, z + 0.06, 'paint');
  // rear wall (engine grille) + rear window
  s.box('b', -hw, wy0, zT, hw, wy1, zT + 0.15, 'paint');
  s.box('g', -hw + 0.25, wy0 + 0.15, zT - 0.012, hw - 0.25, wy1 - 0.1, zT + 0.02);
  s.box('b', -0.9, 0.6, zT - 0.02, 0.9, 1.15, zT + 0.02, 'grille');
  for (let i = 1; i <= 4; i++) s.box('b', -0.88, 0.6 + i * 0.11 - 0.012, zT - 0.03, 0.88, 0.6 + i * 0.11 + 0.012, zT - 0.015, 'darkmetal');
  // front: big windshield, destination sign, bumper, lights
  s.taper('g', [-hw + 0.05, hw - 0.05, zN - 0.2, zN - 0.02], 1.05, [-hw + 0.05, hw - 0.05, zN - 0.2, zN - 0.08], 2.75);
  s.box('b', -hw, 0.42, zN - 0.15, hw, 1.05, zN, 'paint');
  s.box('b', -hw, 2.75, zN - 0.15, hw, H, zN - 0.02, 'paint');
  s.box('l', -0.95, 2.82, zN - 0.04, 0.95, 3.12, zN + 0.005, 0, 'sign');
  s.pair('b', hw - 0.1, 1.05, zN - 0.16, hw + 0.004, 2.75, zN - 0.02, 'paint');
  s.box('b', -hw + 0.02, y0 + 0.02, zN - 0.04, hw - 0.02, y0 + 0.32, zN + 0.1, 'trimL');
  s.box('b', -hw + 0.02, y0 + 0.02, zT - 0.1, hw - 0.02, y0 + 0.3, zT + 0.04, 'trimL');
  s.pair('l', 0.85, 0.6, zN - 0.02, 1.32, 0.82, zN + 0.035, 0, 'head');
  s.pair('l', 0.6, 0.6, zN - 0.02, 0.83, 0.75, zN + 0.03, 0, 'ind');
  s.pair('l', 1.05, 1.3, zT - 0.03, 1.36, 1.85, zT + 0.02, 0, 'tail');
  s.pair('l', 1.05, 1.1, zT - 0.03, 1.36, 1.27, zT + 0.02, 0, 'rev');
  plate(s, zN + 0.1, 1, y0 + 0.08);
  plate(s, zT - 0.03, -1, 0.42 + 0.35);
  mirrors(s, hw, zN - 0.2, 2.2, 'trim');
  s.pair('b', hw + 0.1, 1.8, zN - 0.26, hw + 0.15, 2.3, zN - 0.16, 'trim');
  // passenger doors on the curb side (right = -x): dark glass doors front + middle
  s.box('g', -hw - 0.012, 0.5, zN - 1.45, -hw + 0.02, wy1, zN - 0.35);
  s.box('b', -hw - 0.014, 0.5, zN - 0.92, -hw - 0.004, wy1, zN - 0.88, 'trim');
  s.box('g', -hw - 0.012, 0.5, -0.9, -hw + 0.02, wy1, 0.3);
  s.box('b', -hw - 0.014, 0.5, -0.32, -hw - 0.004, wy1, -0.28, 'trim');
  // the glass doors cut through the lower wall: dark frame below them
  s.box('b', -hw - 0.01, 0.42, zN - 1.5, -hw + 0.01, 0.5, zN - 0.3, 'trim');
  interior(s, { xb: hw - 0.1, zDash: zN - 0.2, zSeat: zN - 0.9, y0: 1.3, rows: 1, hw });
  for (let z = zN - 2.2; z > zT + 1; z -= 1.1) s.pair('b', 0.3, 1.0, z - 0.18, 1.15, 1.8, z + 0.05, 'seat');
  s.meta.driver = { x: 0.7, y: 1.0, z: zN - 0.95 };
  s.meta.engine = { x: 0, y: 1.2, z: zT + 0.8 };
  s.meta.exhaust = { x: -1.0, y: 0.5, z: zT - 0.1 };
}

function buildBike(s) {
  // frame + engine + tank + seat + fairing; wheels are separate (z = +0.8 / -0.78, r = 0.33)
  s.box('b', -0.16, 0.24, -0.36, 0.16, 0.62, 0.32, 'darkmetal');                // engine block
  s.box('b', -0.17, 0.3, -0.2, 0.17, 0.5, 0.2, 'metal');                         // cylinders
  s.pair('b', 0.17, 0.33, -0.12, 0.2, 0.47, 0.12, 'chrome');                      // engine covers
  s.taper('b', [-0.2, 0.2, 0.0, 0.62], 0.66, [-0.16, 0.16, 0.05, 0.5], 0.95, 'paint'); // tank
  s.box('b', -0.17, 0.72, -0.62, 0.17, 0.84, 0.04, 'black');                     // seat
  s.taper('b', [-0.16, 0.16, -0.95, -0.55], 0.72, [-0.08, 0.08, -0.98, -0.6], 0.96, 'paint'); // tail
  s.box('b', -0.06, 0.62, -0.92, 0.06, 0.66, -0.4, 'trim');                     // tail undertray
  // front fairing + windscreen + headlight
  s.loft('b', 0.52, [-0.2, 0.2, 0.6, 1.05], 0.92, [-0.13, 0.13, 0.72, 0.98], 'paint');
  s.loft('g', 0.62, [-0.15, 0.15, 1.0, 1.08], 0.84, [-0.11, 0.11, 1.0, 1.28]);
  s.box('l', -0.1, 0.8, 0.9, 0.1, 0.9, 0.95, 0, 'head');
  s.pair('l', 0.12, 0.84, 0.86, 0.17, 0.88, 0.92, 0, 'ind');
  s.box('l', -0.07, 0.86, -0.99, 0.07, 0.91, -0.96, 0, 'tail');
  s.box('b', -0.08, 0.6, -1.0, 0.08, 0.72, -0.96, 'plate');
  // forks (sheared) + handlebars + mirrors
  const fk = [0.1, 0.3, 0.76, 0.14, 0.3, 0.76, 0.14, 0.3, 0.82, 0.1, 0.3, 0.82, 0.1, 1.02, 0.6, 0.14, 1.02, 0.6, 0.14, 1.02, 0.66, 0.1, 1.02, 0.66];
  s.hexa('b', fk, 'chrome'); s.mirrorHexa('b', fk, 'chrome');
  s.box('b', -0.38, 1.0, 0.56, 0.38, 1.04, 0.6, 'black');
  s.pair('b', 0.3, 0.98, 0.54, 0.4, 1.06, 0.62, 'rubber');
  s.pair('b', 0.26, 1.06, 0.58, 0.28, 1.2, 0.6, 'black');
  s.pair('b', 0.22, 1.18, 0.56, 0.32, 1.24, 0.6, 'black');
  // swingarm + exhaust + fenders
  s.pair('b', 0.08, 0.28, -0.78, 0.12, 0.38, -0.25, 'darkmetal');
  s.box('b', -0.3, 0.26, -0.75, -0.18, 0.4, -0.15, 'chrome');
  s.box('b', -0.29, 0.28, -0.82, -0.19, 0.38, -0.75, 'black');
  s.box('b', -0.08, 0.66, 0.6, 0.08, 0.7, 1.02, 'paint');
  s.box('b', -0.09, 0.62, -0.95, 0.09, 0.66, -0.6, 'paint');
  s.meta.driver = { x: 0, y: 0.82, z: -0.25 };
  s.meta.engine = { x: 0, y: 0.6, z: 0.1 };
  s.meta.exhaust = { x: -0.24, y: 0.33, z: -0.85 };
}

function buildHeli(s, police) {
  // skids
  s.pair('b', 0.88, 0.0, -1.5, 1.0, 0.08, 1.7, 'darkmetal');
  s.pair('b', 0.88, 0.05, 1.7, 1.0, 0.12, 1.85, 'darkmetal');
  for (const z of [-0.9, 0.9]) {
    const st = [0.9, 0.08, z - 0.05, 0.96, 0.08, z - 0.05, 0.96, 0.08, z + 0.05, 0.9, 0.08, z + 0.05,
      0.62, 0.5, z - 0.05, 0.68, 0.5, z - 0.05, 0.68, 0.5, z + 0.05, 0.62, 0.5, z + 0.05];
    s.hexa('b', st, 'darkmetal'); s.mirrorHexa('b', st, 'darkmetal');
  }
  // cabin body
  s.box('b', -1.05, 0.45, -1.3, 1.05, 1.15, 1.3, 'paint');
  s.box('b', -1.05, 1.15, -1.3, 1.05, 1.95, -0.95, 'paint');
  s.box('b', -1.0, 1.9, -1.3, 1.0, 2.05, 0.65, 'paint');
  // nose (lower, painted) + cockpit glass bubble
  s.loft('b', 1.3, [-1.05, 1.05, 0.45, 1.15], 2.55, [-0.62, 0.62, 0.55, 0.9], 'paint');
  s.loft('g', 0.25, [-0.99, 0.99, 1.15, 1.95], 2.5, [-0.6, 0.6, 0.9, 1.25]);
  s.box('g', -1.0, 1.15, -0.92, 1.0, 1.85, 0.26);
  s.pair('b', 0.995, 1.15, -0.4, 1.01, 1.9, -0.3, 'paint');                // door frames
  s.pair('b', 0.995, 1.15, 0.22, 1.01, 1.92, 0.3, 'paint');
  // stripe
  s.pair('b', 1.048, 0.75, -1.25, 1.058, 0.9, 1.25, 'paint2');
  // engine housing + mast
  s.box('b', -0.7, 2.05, -1.45, 0.7, 2.42, 0.45, 'paint2');
  s.pair('b', 0.7, 2.12, -1.2, 0.72, 2.32, -0.6, 'grille');
  s.box('b', -0.1, 2.42, -0.1, 0.1, 2.6, 0.1, 'darkmetal');
  // tail boom, fin, stabiliser, skid guard
  s.loft('b', -4.25, [-0.16, 0.16, 1.35, 1.66], -1.3, [-0.38, 0.38, 1.12, 1.95], 'paint');
  const fin = [-0.06, 1.5, -4.3, 0.06, 1.5, -4.3, 0.06, 1.5, -3.75, -0.06, 1.5, -3.75,
    -0.05, 2.7, -4.6, 0.05, 2.7, -4.6, 0.05, 2.7, -4.25, -0.05, 2.7, -4.25];
  s.hexa('b', fin, 'paint');
  s.box('b', -0.85, 1.48, -3.55, 0.85, 1.54, -3.2, 'paint');
  s.pair('b', 0.8, 1.4, -3.6, 0.86, 1.7, -3.15, 'paint2');
  s.box('b', -0.03, 1.1, -4.2, 0.03, 1.36, -4.05, 'darkmetal');
  s.box('b', -0.16, 1.95, -4.05, -0.12, 2.25, -3.85, 'darkmetal'); // tail rotor gearbox (right side)
  interior(s, { xb: 0.95, zDash: 1.4, zSeat: 0.75, y0: 1.08, rows: 1, hw: 1.0 });
  // lights: nav red (left), green (right), white tail strobe, belly beacon
  s.box('l', 1.05, 1.0, 0.6, 1.1, 1.08, 0.75, 0, 'navR');
  s.box('l', -1.1, 1.0, 0.6, -1.05, 1.08, 0.75, 0, 'navG');
  s.box('l', -0.04, 2.7, -4.6, 0.04, 2.78, -4.5, 0, 'strobe');
  s.box('l', -0.07, 0.38, -0.3, 0.07, 0.45, -0.15, 0, 'navR');
  s.box('l', -0.3, 0.55, 2.4, 0.3, 0.7, 2.52, 0, 'head');
  if (police) {
    s.box('b', -0.22, 0.25, 1.75, 0.22, 0.5, 2.15, 'darkmetal');
    s.box('l', -0.16, 0.2, 1.8, 0.16, 0.3, 2.1, 0, 'search');
    s.box('l', 0.1, 2.05, 0.66, 0.6, 2.13, 0.8, 0, 'barR');
    s.box('l', -0.6, 2.05, 0.66, -0.1, 2.13, 0.8, 0, 'barB');
  }
  s.meta.driver = { x: 0.48, y: 0.78, z: 1.0 };
  s.meta.engine = { x: 0, y: 2.4, z: -0.5 };
  s.meta.exhaust = { x: 0, y: 2.3, z: -1.5 };
  s.meta.rotor = { x: 0, y: 2.62, z: 0 };
  s.meta.tailRotor = { x: -0.24, y: 2.1, z: -3.95 };
}

const BUILDERS = {
  sedan: (s) => buildSedan(s, 'sedan'),
  taxi: (s) => buildSedan(s, 'taxi'),
  police: (s) => buildSedan(s, 'police'),
  sports: buildSports,
  supercar: buildSupercar,
  muscle: buildMuscle,
  pickup: buildPickup,
  van: (s) => buildVan(s, 'van'),
  ambulance: (s) => buildVan(s, 'ambulance'),
  swat: (s) => buildVan(s, 'swat'),
  truck: buildTruck,
  bus: buildBus,
  bike: buildBike,
  heli: (s) => buildHeli(s, false),
  police_heli: (s) => buildHeli(s, true),
};

// ------------------------------------------------------------------------------------------------ caches
const specCache = new Map();
/** Part spec of a model (cached). */
export function getSpec(model) {
  let s = specCache.get(model);
  if (!s) {
    s = new Spec();
    (BUILDERS[model] || BUILDERS.sedan)(s);
    specCache.set(model, s);
  }
  return s;
}

const bodyCache = new Map(); // key -> {geo, refs}
/** Ref-counted body geometry for model + paint (+ burnt). Call releaseBody(key) when done. */
export function acquireBody(model, paint, paint2, burnt = false) {
  const key = burnt ? `${model}|burnt` : `${model}|${paint}|${paint2}`;
  let e = bodyCache.get(key);
  if (!e) {
    const spec = getSpec(model);
    const geo = bake(spec.b, makeResolver(paint, paint2, burnt), burnt ? { jitter: 0.18, seed: 3 } : {});
    e = { geo, refs: 0 };
    bodyCache.set(key, e);
  }
  e.refs++;
  return { key, geo: e.geo };
}

export function releaseBody(key) {
  const e = bodyCache.get(key);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) { e.geo.dispose(); bodyCache.delete(key); }
}

const glassCache = new Map();
/** Shared glass geometry of a model (null when it has none). */
export function glassGeometry(model) {
  if (glassCache.has(model)) return glassCache.get(model);
  const spec = getSpec(model);
  const geo = spec.g.length ? bake(spec.g, () => 0xffffff) : null;
  glassCache.set(model, geo);
  return geo;
}

export const LIGHT_ROLES = ['none', 'head', 'tail', 'rev', 'ind', 'barR', 'barB', 'barW', 'sign', 'navR', 'navG', 'strobe', 'search'];
const ROLE_INDEX = new Map(LIGHT_ROLES.map((r, i) => [r, i]));
const lightTemplates = new Map();
/** A fresh per-vehicle copy of the model's light geometry (userData.roles = role index per vertex), or null. */
export function lightsGeometry(model) {
  let t = lightTemplates.get(model);
  if (t === undefined) {
    const spec = getSpec(model);
    t = spec.l.length ? bake(spec.l, () => 0xffffff, { roles: ROLE_INDEX }) : null;
    lightTemplates.set(model, t);
  }
  if (!t) return null;
  // full copy: sharing attributes between geometries that get disposed independently breaks three's VAO cache
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', t.attributes.position.clone());
  g.setAttribute('normal', t.attributes.normal.clone());
  g.setAttribute('color', t.attributes.color.clone());
  g.userData.roles = t.userData.roles;
  g.boundingSphere = t.boundingSphere.clone();
  return g;
}

/** Colour table for light roles: [off, on] sRGB hex. */
export const LIGHT_COLORS = {
  none: [0x000000, 0x000000],
  head: [0xb9c2c9, 0xfff6d6],
  tail: [0x5a0c0c, 0xd4201c],
  brake: [0xff3a30, 0xff4a3a],
  rev: [0x8a8a8a, 0xf6f6f0],
  ind: [0x8c5410, 0xffae2a],
  barR: [0x4a0e0e, 0xff2a22],
  barB: [0x0e1650, 0x2f62ff],
  barW: [0x7c7c7c, 0xffffff],
  sign: [0xb9a24a, 0xfff0a0],
  navR: [0x7a1010, 0xff2a20],
  navG: [0x0e5a1a, 0x2aff50],
  strobe: [0x8a8a8a, 0xffffff],
  search: [0x9a9a8a, 0xfffbe0],
};

const wheelCache = new Map();
/** Shared wheel geometry (axle along X, centred at the hub). */
export function wheelGeometry(r, w) {
  const key = `${r.toFixed(3)}:${w.toFixed(3)}`;
  let g = wheelCache.get(key);
  if (g) return g;
  const segs = 12;
  const tire = flatColored(new THREE.CylinderGeometry(r, r, w, segs, 1), 0x181818);
  const side = flatColored(new THREE.CylinderGeometry(r * 0.86, r * 0.86, w + 0.012, segs, 1), 0x222222);
  const rim = flatColored(new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.026, segs, 1), 0xb4b9be);
  const hub = flatColored(new THREE.CylinderGeometry(r * 0.2, r * 0.2, w + 0.05, 6, 1), 0x3a3c40);
  // spokes: thin boxes on both faces (give the spin something to show)
  const spokes = [];
  for (let i = 0; i < 3; i++) {
    const b = flatColored(new THREE.BoxGeometry(w + 0.034, r * 1.12, r * 0.12), 0x6f747a);
    b.rotateX((i * Math.PI) / 3);
    spokes.push(b);
  }
  g = mergeColored([tire, side, rim, ...spokes, hub]);
  g.rotateZ(Math.PI / 2);
  g.computeBoundingSphere();
  wheelCache.set(key, g);
  return g;
}

let rotorGeo = null, tailRotorGeo = null;
/** Main rotor (spins about Y) and tail rotor (spins about X) geometries. */
export function rotorGeometries(R = 5) {
  if (rotorGeo) return { main: rotorGeo, tail: tailRotorGeo };
  const parts = [];
  const blade = (rot) => {
    const b = flatColored(new THREE.BoxGeometry(R * 2, 0.05, 0.3), 0x2a2b2e);
    b.rotateY(rot);
    parts.push(b);
  };
  blade(0); blade(Math.PI / 2);
  for (const rot of [0, Math.PI / 2]) {
    const tip = flatColored(new THREE.BoxGeometry(0.4, 0.055, 0.31), 0xd8d23a);
    const t2 = tip.clone();
    tip.translate(R - 0.2, 0, 0); t2.translate(-R + 0.2, 0, 0);
    tip.rotateY(rot); t2.rotateY(rot);
    parts.push(tip, t2);
  }
  parts.push(flatColored(new THREE.BoxGeometry(0.42, 0.18, 0.42), 0x3a3c40));
  rotorGeo = mergeColored(parts);
  const tp = [];
  const tb = flatColored(new THREE.BoxGeometry(0.04, 1.3, 0.16), 0x2a2b2e);
  const tb2 = tb.clone(); tb2.rotateX(Math.PI / 2);
  tp.push(tb, tb2, flatColored(new THREE.BoxGeometry(0.08, 0.14, 0.14), 0x3a3c40));
  tailRotorGeo = mergeColored(tp);
  return { main: rotorGeo, tail: tailRotorGeo };
}

const DRIVER_ROLES = new Map([['shirt', 1], ['skin', 2], ['hair', 3], ['hat', 4], ['pants', 5], ['eye', 6]]);
const driverTemplates = {};
function driverTemplate(hat) {
  const key = hat ? 'hat' : 'bare';
  if (driverTemplates[key]) return driverTemplates[key];
  const s = new Spec();
  const B = (x0, y0, z0, x1, y1, z1, role) => s.box('b', x0, y0, z0, x1, y1, z1, role, role);
  B(-0.2, 0.0, -0.12, 0.2, 0.52, 0.1, 'shirt');                 // torso
  B(-0.19, -0.05, 0.0, 0.19, 0.1, 0.42, 'pants');               // thighs
  B(-0.24, 0.22, -0.06, -0.14, 0.5, 0.08, 'shirt');             // arms reaching to the wheel
  B(0.14, 0.22, -0.06, 0.24, 0.5, 0.08, 'shirt');
  B(-0.22, 0.22, 0.08, -0.12, 0.32, 0.36, 'skin');
  B(0.12, 0.22, 0.08, 0.22, 0.32, 0.36, 'skin');
  B(-0.06, 0.52, -0.06, 0.06, 0.58, 0.06, 'skin');              // neck
  B(-0.15, 0.58, -0.15, 0.15, 0.88, 0.15, 'skin');              // head
  B(-0.16, 0.82, -0.16, 0.16, 0.9, 0.16, 'hair');
  B(-0.16, 0.6, -0.17, 0.16, 0.86, -0.12, 'hair');
  B(-0.09, 0.72, 0.15, -0.03, 0.76, 0.16, 'eye');
  B(0.03, 0.72, 0.15, 0.09, 0.76, 0.16, 'eye');
  if (hat) { B(-0.17, 0.86, -0.17, 0.17, 0.96, 0.17, 'hat'); B(-0.17, 0.86, 0.15, 0.17, 0.89, 0.28, 'hat'); }
  // white resolve -> the colour attribute holds the baked per-face shade
  driverTemplates[key] = bake(s.b, () => 0xffffff, { roles: DRIVER_ROLES });
  return driverTemplates[key];
}

/**
 * A per-vehicle seated driver figure (origin = hip on the seat, faces +Z), recoloured for `look`
 * ({skin, hair, shirt, pants?, hat?}). The caller owns (and disposes) the returned geometry.
 */
export function driverGeometry(look = {}) {
  const L = { skin: 0xe0ac69, hair: 0x2b1b0e, shirt: 0x34495e, pants: 0x2c3e50, hat: null, ...(look || {}) };
  const t = driverTemplate(!!L.hat);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', t.attributes.position.clone());
  g.setAttribute('normal', t.attributes.normal.clone());
  const shade = t.attributes.color.array, roles = t.userData.roles;
  const col = new Float32Array(shade.length);
  const tbl = [];
  for (const [role, i] of DRIVER_ROLES) {
    const hex = role === 'eye' ? 0x222244 : L[role] ?? 0x888888;
    const c = new THREE.Color(hex);
    tbl[i] = [c.r, c.g, c.b];
  }
  for (let v = 0; v < roles.length; v++) {
    const c = tbl[roles[v]] || tbl[1];
    col[v * 3] = c[0] * shade[v * 3]; col[v * 3 + 1] = c[1] * shade[v * 3 + 1]; col[v * 3 + 2] = c[2] * shade[v * 3 + 2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.boundingSphere = t.boundingSphere.clone();
  return g;
}

/** Statistics for tests: triangle counts per model. */
export function modelStats(model) {
  const s = getSpec(model);
  return { bodyParts: s.b.length, glassParts: s.g.length, lightParts: s.l.length, bodyTris: s.b.length * 12 };
}

/** All model ids. */
export const MODEL_IDS = Object.keys(BUILDERS);

/** Def lookup convenience for tests. */
export function defOf(type) { return VEHICLE_TYPES[type]; }
