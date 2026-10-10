// Voxel-style weapon / tool models (COMBAT). Every model is built from small vertex-coloured boxes merged into one
// geometry (one draw call), at real-world scale in metres, pointing +Z with +Y up and the GRIP (hand) at the origin.
// Models are built once and cached; getWeaponModel(id) returns a clone that shares geometry + material.
//   userData.weaponId, userData.muzzle [x,y,z] (barrel end in model space), userData.length (m)
// The RPG has a separate child mesh named 'warhead' (hidden while unloaded).
import * as THREE from 'three';

const _c = new THREE.Color();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

// palette
const GUN_BLACK = 0x1f2024, GUN_DARK = 0x33363c, GUN_GREY = 0x5b6067, METAL = 0x9aa1a8, METAL_LIGHT = 0xc9cfd4;
const POLY = 0x18191c, WOOD = 0x7a4a26, WOOD_LIGHT = 0x9c6634, WOOD_DARK = 0x4d2e17;
const OLIVE = 0x56603a, OLIVE_DARK = 0x3c4428, TAN = 0x9b8763, TAN_DARK = 0x7c6a4a, BAKELITE = 0x7a3518;
const BAT_WOOD = 0xc8955a, BAT_LIGHT = 0xd9ab70, IRON = 0xb8c0c6, IRON_DARK = 0x737c84, IRON_EDGE = 0xe6ebee;

/**
 * Non-indexed box with a flat vertex colour and baked per-face shade (crisp voxel read under any light).
 * Dimensions/offsets in metres; optional rotation (radians, XYZ) applied about the box centre before translation.
 */
export function vbox(w, h, d, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  if (rx || ry || rz) { _m.makeRotationFromEuler(_e.set(rx, ry, rz)); g.applyMatrix4(_m); }
  g.translate(x, y, z);
  _c.set(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const nrm = g.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const ny = nrm[i * 3 + 1], nx = nrm[i * 3];
    const shade = ny > 0.5 ? 1.12 : ny < -0.5 ? 0.66 : Math.abs(nx) > 0.5 ? 0.86 : 0.97;
    col[i * 3] = Math.min(1, _c.r * shade); col[i * 3 + 1] = Math.min(1, _c.g * shade); col[i * 3 + 2] = Math.min(1, _c.b * shade);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Merge non-indexed position/normal/color geometries into one (inputs disposed). */
export function mergeBoxes(geos) {
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
  m.computeBoundingBox();
  return m;
}

// ------------------------------------------------------------------------------------------- model recipes
// Each returns { parts: [geometries], muzzle: [x,y,z], extra?: { name: [geometries] } }

function pistol() {
  return {
    parts: [
      vbox(0.034, 0.038, 0.215, GUN_DARK, 0, 0.062, 0.058),          // slide
      vbox(0.0355, 0.03, 0.035, GUN_BLACK, 0, 0.06, -0.03),          // rear serrations
      vbox(0.012, 0.004, 0.045, GUN_BLACK, -0.01, 0.0815, 0.07),     // ejection port
      vbox(0.03, 0.024, 0.17, POLY, 0, 0.032, 0.05),                  // frame + dust cover
      vbox(0.017, 0.017, 0.02, GUN_BLACK, 0, 0.064, 0.172),           // barrel crown
      vbox(0.03, 0.108, 0.046, POLY, 0, -0.024, -0.012, 0.22),        // raked grip
      vbox(0.031, 0.06, 0.03, 0x24262a, 0, -0.03, -0.012, 0.22),      // grip texture panel
      vbox(0.033, 0.012, 0.05, GUN_BLACK, 0, -0.08, -0.027, 0.22),    // magazine base
      vbox(0.011, 0.007, 0.052, POLY, 0, -0.002, 0.05),               // trigger guard (bottom)
      vbox(0.011, 0.03, 0.008, POLY, 0, 0.012, 0.076),                // trigger guard (front)
      vbox(0.006, 0.02, 0.006, GUN_BLACK, 0, 0.012, 0.036),           // trigger
      vbox(0.006, 0.01, 0.008, GUN_BLACK, 0, 0.086, 0.155),           // front sight
      vbox(0.028, 0.01, 0.008, GUN_BLACK, 0, 0.086, -0.038),          // rear sight
      vbox(0.006, 0.004, 0.004, 0xf2f2f2, 0, 0.092, 0.155),           // sight dot
    ],
    muzzle: [0, 0.064, 0.185],
  };
}

function smg() {
  return {
    parts: [
      vbox(0.044, 0.062, 0.25, GUN_DARK, 0, 0.045, 0.06),            // receiver
      vbox(0.02, 0.012, 0.2, GUN_BLACK, 0, 0.082, 0.05),             // top rail
      vbox(0.05, 0.052, 0.1, POLY, 0, 0.04, 0.18),                   // handguard
      vbox(0.051, 0.006, 0.1, 0x2a2b2f, 0, 0.03, 0.18),              // handguard groove
      vbox(0.02, 0.02, 0.07, GUN_BLACK, 0, 0.05, 0.26),              // barrel
      vbox(0.026, 0.026, 0.02, GUN_BLACK, 0, 0.05, 0.29),            // muzzle cap
      vbox(0.022, 0.026, 0.012, GUN_BLACK, 0, 0.083, 0.22),          // front sight hood
      vbox(0.026, 0.018, 0.016, GUN_BLACK, 0, 0.094, -0.05),         // rear sight drum
      vbox(0.03, 0.095, 0.042, POLY, 0, -0.03, -0.005, 0.25),        // grip
      vbox(0.026, 0.15, 0.034, GUN_BLACK, 0, -0.065, 0.088, -0.12),  // magazine (slightly forward-curved)
      vbox(0.028, 0.012, 0.038, GUN_GREY, 0, -0.138, 0.097, -0.12),  // mag base plate
      vbox(0.011, 0.007, 0.05, POLY, 0, -0.006, 0.035),              // trigger guard
      vbox(0.006, 0.018, 0.006, GUN_BLACK, 0, 0.005, 0.03),          // trigger
      vbox(0.008, 0.008, 0.1, GUN_GREY, 0.017, 0.045, -0.115),       // stock rails
      vbox(0.008, 0.008, 0.1, GUN_GREY, -0.017, 0.045, -0.115),
      vbox(0.044, 0.07, 0.012, GUN_BLACK, 0, 0.032, -0.165),         // butt plate
      vbox(0.012, 0.012, 0.03, METAL, -0.027, 0.07, 0.16),           // cocking handle
    ],
    muzzle: [0, 0.05, 0.3],
  };
}

function shotgun() {
  return {
    parts: [
      vbox(0.045, 0.075, 0.28, WOOD, 0, -0.012, -0.27, 0.07),         // stock
      vbox(0.047, 0.088, 0.016, GUN_BLACK, 0, -0.026, -0.416, 0.07),  // recoil pad
      vbox(0.04, 0.058, 0.08, WOOD_DARK, 0, -0.004, -0.09),           // wrist
      vbox(0.048, 0.07, 0.2, GUN_DARK, 0, 0.035, 0.03),               // receiver
      vbox(0.049, 0.02, 0.06, GUN_BLACK, 0, 0.05, 0.05),              // ejection port
      vbox(0.012, 0.008, 0.06, GUN_BLACK, 0, -0.008, 0.0),            // trigger guard
      vbox(0.006, 0.02, 0.006, GUN_BLACK, 0, 0.004, 0.0),             // trigger
      vbox(0.026, 0.026, 0.42, GUN_BLACK, 0, 0.056, 0.34),            // barrel
      vbox(0.022, 0.022, 0.34, GUN_DARK, 0, 0.026, 0.3),              // magazine tube
      vbox(0.044, 0.044, 0.15, WOOD_LIGHT, 0, 0.03, 0.29),            // pump
      vbox(0.046, 0.005, 0.15, WOOD_DARK, 0, 0.04, 0.29),             // pump grooves
      vbox(0.046, 0.005, 0.15, WOOD_DARK, 0, 0.02, 0.29),
      vbox(0.03, 0.05, 0.012, GUN_BLACK, 0, 0.043, 0.5),              // barrel band
      vbox(0.008, 0.008, 0.008, METAL_LIGHT, 0, 0.073, 0.54),         // bead sight
    ],
    muzzle: [0, 0.056, 0.56],
  };
}

function rifle() {
  return {
    parts: [
      vbox(0.042, 0.07, 0.25, WOOD, 0, -0.01, -0.25, 0.1),            // stock
      vbox(0.044, 0.08, 0.012, GUN_BLACK, 0, -0.026, -0.376, 0.1),    // butt plate
      vbox(0.03, 0.09, 0.04, WOOD_DARK, 0, -0.038, -0.045, 0.3),      // pistol grip
      vbox(0.046, 0.07, 0.29, GUN_DARK, 0, 0.03, 0.02),               // receiver
      vbox(0.04, 0.016, 0.25, GUN_BLACK, 0, 0.072, 0.0),              // dust cover
      vbox(0.03, 0.02, 0.03, GUN_BLACK, 0, 0.072, 0.16),              // rear sight block
      vbox(0.05, 0.045, 0.17, WOOD, 0, 0.026, 0.25),                  // lower handguard
      vbox(0.036, 0.024, 0.14, WOOD_LIGHT, 0, 0.062, 0.245),          // upper handguard (gas tube)
      vbox(0.018, 0.018, 0.2, GUN_BLACK, 0, 0.035, 0.42),             // barrel
      vbox(0.02, 0.042, 0.015, GUN_BLACK, 0, 0.056, 0.49),            // front sight post
      vbox(0.025, 0.025, 0.032, GUN_BLACK, 0, 0.035, 0.536),          // muzzle brake
      vbox(0.028, 0.085, 0.05, BAKELITE, 0, -0.032, 0.09, -0.15),     // curved magazine
      vbox(0.028, 0.08, 0.05, BAKELITE, 0, -0.1, 0.118, -0.45),
      vbox(0.011, 0.008, 0.05, GUN_BLACK, 0, -0.01, 0.015),           // trigger guard
      vbox(0.006, 0.02, 0.006, GUN_BLACK, 0, 0.0, 0.01),              // trigger
      vbox(0.02, 0.012, 0.022, METAL, -0.028, 0.045, 0.12),           // charging handle
      vbox(0.012, 0.03, 0.022, GUN_BLACK, -0.026, 0.03, -0.06),       // selector lever
    ],
    muzzle: [0, 0.035, 0.555],
  };
}

function sniper() {
  return {
    parts: [
      vbox(0.05, 0.09, 0.3, TAN, 0, -0.015, -0.27),                  // stock
      vbox(0.04, 0.03, 0.14, TAN_DARK, 0, 0.045, -0.25),             // cheek riser
      vbox(0.052, 0.1, 0.016, GUN_BLACK, 0, -0.015, -0.425),         // butt pad
      vbox(0.032, 0.085, 0.04, TAN, 0, -0.042, -0.07, 0.25),         // grip
      vbox(0.044, 0.055, 0.28, GUN_DARK, 0, 0.03, 0.02),             // receiver
      vbox(0.05, 0.045, 0.24, TAN, 0, 0.0, 0.25),                    // forend
      vbox(0.022, 0.022, 0.5, GUN_BLACK, 0, 0.035, 0.43),            // barrel
      vbox(0.034, 0.034, 0.05, GUN_BLACK, 0, 0.035, 0.68),           // muzzle brake
      vbox(0.036, 0.008, 0.012, GUN_GREY, 0, 0.035, 0.665),          // brake ports
      vbox(0.034, 0.034, 0.26, GUN_BLACK, 0, 0.1, 0.03),             // scope tube
      vbox(0.05, 0.05, 0.06, GUN_BLACK, 0, 0.1, 0.17),               // objective bell
      vbox(0.044, 0.044, 0.04, GUN_BLACK, 0, 0.1, -0.11),            // eyepiece
      vbox(0.036, 0.036, 0.004, 0x3f78b0, 0, 0.1, 0.2015),           // front lens
      vbox(0.03, 0.03, 0.004, 0x2a4f78, 0, 0.1, -0.1315),            // rear lens
      vbox(0.018, 0.022, 0.018, GUN_DARK, 0, 0.127, 0.03),           // elevation turret
      vbox(0.022, 0.018, 0.018, GUN_DARK, 0.026, 0.1, 0.03),         // windage turret
      vbox(0.02, 0.03, 0.02, GUN_DARK, 0, 0.069, -0.05),             // scope rings
      vbox(0.02, 0.03, 0.02, GUN_DARK, 0, 0.069, 0.1),
      vbox(0.05, 0.012, 0.012, METAL, -0.035, 0.035, -0.06),         // bolt handle
      vbox(0.02, 0.02, 0.02, METAL_LIGHT, -0.062, 0.03, -0.06),      // bolt knob
      vbox(0.01, 0.01, 0.16, GUN_DARK, 0.014, -0.03, 0.42),          // folded bipod legs
      vbox(0.01, 0.01, 0.16, GUN_DARK, -0.014, -0.03, 0.42),
      vbox(0.011, 0.008, 0.05, GUN_BLACK, 0, -0.01, 0.0),            // trigger guard
    ],
    muzzle: [0, 0.035, 0.71],
  };
}

function rpg() {
  return {
    parts: [
      vbox(0.085, 0.085, 0.85, OLIVE, 0, 0.09, 0.125),               // launch tube
      vbox(0.12, 0.12, 0.06, OLIVE_DARK, 0, 0.09, -0.33),            // rear flare
      vbox(0.1, 0.1, 0.22, WOOD, 0, 0.09, 0.08),                     // heat guard
      vbox(0.102, 0.012, 0.22, WOOD_DARK, 0, 0.11, 0.08),
      vbox(0.09, 0.09, 0.02, OLIVE_DARK, 0, 0.09, 0.54),             // muzzle ring
      vbox(0.03, 0.1, 0.04, GUN_BLACK, 0, 0.0, 0.0, 0.15),           // rear grip
      vbox(0.03, 0.09, 0.04, GUN_BLACK, 0, 0.005, 0.24),             // front grip
      vbox(0.011, 0.008, 0.05, GUN_BLACK, 0, 0.03, -0.03),           // trigger guard
      vbox(0.028, 0.055, 0.06, GUN_BLACK, -0.06, 0.135, 0.18),       // optic
      vbox(0.02, 0.02, 0.004, 0x3f78b0, -0.06, 0.145, 0.212),        // optic lens
      vbox(0.012, 0.03, 0.012, GUN_DARK, -0.045, 0.12, 0.18),        // optic mount
    ],
    extra: {
      warhead: [
        vbox(0.05, 0.05, 0.06, GUN_GREY, 0, 0.09, 0.575),            // neck
        vbox(0.12, 0.12, 0.12, 0x5e6b3a, 0, 0.09, 0.66),             // warhead body
        vbox(0.09, 0.09, 0.06, 0x56633a, 0, 0.09, 0.75),             // cone stages
        vbox(0.055, 0.055, 0.05, 0x4c5833, 0, 0.09, 0.8),
        vbox(0.02, 0.02, 0.04, METAL, 0, 0.09, 0.84),                // fuse tip
      ],
    },
    muzzle: [0, 0.09, 0.62],
  };
}

function bat() {
  return {
    parts: [
      vbox(0.052, 0.052, 0.02, WOOD_DARK, 0, 0, -0.07),               // knob
      vbox(0.034, 0.034, 0.2, 0x202124, 0, 0, 0.03),                  // grip tape
      vbox(0.035, 0.035, 0.012, 0x3b3d42, 0, 0, 0.08),
      vbox(0.034, 0.034, 0.17, BAT_WOOD, 0, 0, 0.215),                // handle
      vbox(0.044, 0.044, 0.16, BAT_WOOD, 0, 0, 0.38),                 // taper
      vbox(0.056, 0.056, 0.2, BAT_WOOD, 0, 0, 0.56),                  // barrel
      vbox(0.058, 0.058, 0.02, 0x2a4a9a, 0, 0, 0.5),                  // label stripe
      vbox(0.063, 0.063, 0.14, BAT_LIGHT, 0, 0, 0.73),                // sweet spot
      vbox(0.05, 0.05, 0.016, BAT_WOOD, 0, 0, 0.808),                 // end cap
    ],
    muzzle: [0, 0, 0.75],
  };
}

function grenade() {
  const G = 0x3d5a2a, GD = 0x2b4220;
  return {
    parts: [
      vbox(0.064, 0.076, 0.064, G, 0, 0, 0.03),                       // body
      vbox(0.07, 0.01, 0.07, GD, 0, -0.014, 0.03),                    // segment rings
      vbox(0.07, 0.01, 0.07, GD, 0, 0.016, 0.03),
      vbox(0.07, 0.056, 0.01, GD, 0, 0, 0.03),                        // vertical ridges
      vbox(0.01, 0.056, 0.07, GD, 0, 0, 0.03),
      vbox(0.03, 0.02, 0.03, GUN_GREY, 0, 0.047, 0.03),               // fuse cap
      vbox(0.012, 0.074, 0.016, METAL, 0.033, 0.02, 0.03),            // spoon lever
      vbox(0.022, 0.022, 0.004, METAL_LIGHT, -0.026, 0.06, 0.03),     // pin ring
    ],
    muzzle: [0, 0.05, 0.03],
  };
}

function pickaxe() {
  const p = [
    vbox(0.035, 0.035, 0.62, WOOD, 0, 0, 0.25),
    vbox(0.04, 0.04, 0.04, WOOD_DARK, 0, 0, -0.06),
    vbox(0.06, 0.07, 0.07, IRON_DARK, 0, 0, 0.53),
  ];
  for (const s of [-1, 1]) {
    p.push(vbox(0.045, 0.13, 0.05, IRON, 0, s * 0.1, 0.53));
    p.push(vbox(0.04, 0.08, 0.045, IRON, 0, s * 0.2, 0.515));
    p.push(vbox(0.034, 0.05, 0.04, IRON_EDGE, 0, s * 0.26, 0.495));
  }
  return { parts: p, muzzle: [0, 0.26, 0.5] };
}

function axe() {
  return {
    parts: [
      vbox(0.035, 0.035, 0.62, WOOD, 0, 0, 0.25),
      vbox(0.04, 0.04, 0.04, WOOD_DARK, 0, 0, -0.06),
      vbox(0.05, 0.07, 0.075, IRON_DARK, 0, 0, 0.52),                 // eye
      vbox(0.022, 0.12, 0.1, IRON, 0, 0.085, 0.52),                   // blade
      vbox(0.018, 0.022, 0.13, IRON_EDGE, 0, 0.152, 0.52),            // edge
      vbox(0.045, 0.045, 0.055, IRON_DARK, 0, -0.05, 0.52),           // poll
    ],
    muzzle: [0, 0.16, 0.52],
  };
}

function shovel() {
  return {
    parts: [
      vbox(0.032, 0.032, 0.6, WOOD, 0, 0, 0.24),
      vbox(0.09, 0.03, 0.035, WOOD_DARK, 0, 0, -0.07),                // D-grip
      vbox(0.03, 0.03, 0.05, WOOD_DARK, 0.03, 0, -0.04),
      vbox(0.03, 0.03, 0.05, WOOD_DARK, -0.03, 0, -0.04),
      vbox(0.045, 0.045, 0.06, IRON_DARK, 0, 0, 0.56),                // socket
      vbox(0.15, 0.025, 0.2, IRON, 0, 0, 0.69),                       // spade
      vbox(0.1, 0.022, 0.03, IRON_EDGE, 0, 0, 0.8),                   // tip
    ],
    muzzle: [0, 0, 0.8],
  };
}

/** Rocket projectile (RPG round): body + warhead + fins, pointing +Z, centred on its middle. */
function rocket() {
  const parts = [
    vbox(0.06, 0.06, 0.42, 0x4e5a35, 0, 0, -0.06),                   // motor body
    vbox(0.12, 0.12, 0.13, 0x5e6b3a, 0, 0, 0.2),                      // warhead
    vbox(0.085, 0.085, 0.06, 0x56633a, 0, 0, 0.29),
    vbox(0.05, 0.05, 0.05, 0x4c5833, 0, 0, 0.34),
    vbox(0.018, 0.018, 0.04, METAL, 0, 0, 0.38),
    vbox(0.07, 0.07, 0.03, GUN_DARK, 0, 0, -0.26),                    // nozzle
  ];
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    parts.push(vbox(0.008, 0.07, 0.1, OLIVE_DARK, Math.cos(a) * 0.055, Math.sin(a) * 0.055, -0.21, 0, 0, a - Math.PI / 2));
  }
  return { parts, muzzle: [0, 0, 0.4] };
}

const RECIPES = { pistol, smg, shotgun, rifle, sniper, rpg, bat, grenade, pickaxe, axe, shovel, rocket };

/** Model ids that getWeaponModel understands ('fist' and unknown ids return null). */
export const MODEL_IDS = Object.keys(RECIPES);

let _material = null;
/** Shared lit material for every weapon model (vertex colours). */
export function weaponMaterial() {
  if (!_material) _material = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _material;
}

const _protos = new Map();

function buildProto(id) {
  const recipe = RECIPES[id];
  if (!recipe) return null;
  const r = recipe();
  const root = new THREE.Group();
  root.name = 'weapon:' + id;
  const mat = weaponMaterial();
  const body = new THREE.Mesh(mergeBoxes(r.parts), mat);
  body.name = 'body';
  body.castShadow = true;
  root.add(body);
  const box = body.geometry.boundingBox.clone();
  if (r.extra) {
    for (const [name, geos] of Object.entries(r.extra)) {
      const m = new THREE.Mesh(mergeBoxes(geos), mat);
      m.name = name;
      m.castShadow = true;
      box.union(m.geometry.boundingBox);
      root.add(m);
    }
  }
  root.userData.weaponId = id;
  root.userData.muzzle = r.muzzle.slice();
  root.userData.length = +(box.max.z - box.min.z).toFixed(3);
  return root;
}

/** Cached voxel model for a weapon / tool id, cloned (shared geometry & material). 'fist' / unknown -> null. */
export function getWeaponModel(id) {
  if (!id || !RECIPES[id]) return null;
  let p = _protos.get(id);
  if (!p) { p = buildProto(id); _protos.set(id, p); }
  return p ? p.clone(true) : null;
}

/** Muzzle (barrel end) offset in model space for a weapon id, as a new Vector3 (zero for unknown ids). */
export function muzzleOffset(id, out = new THREE.Vector3()) {
  const p = _protos.get(id) || (RECIPES[id] ? (_protos.set(id, buildProto(id)), _protos.get(id)) : null);
  if (!p) return out.set(0, 0, 0);
  const m = p.userData.muzzle;
  return out.set(m[0], m[1], m[2]);
}

/** Overall model length (m) along +Z, 0 for unknown ids. */
export function modelLength(id) {
  if (!RECIPES[id]) return 0;
  let p = _protos.get(id);
  if (!p) { p = buildProto(id); _protos.set(id, p); }
  return p.userData.length;
}
