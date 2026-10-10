// Voxel models for pickups: cash bundle stack, pixel heart (health), body-armor vest, ammo box, cardboard package,
// atlas-textured mini block, and weapons (Combat's view model when available, else an extruded pixel-art sprite).
// Every builder returns an Object3D centred on its origin, ~0.5-0.75 m across. Geometries are cached per kind.
import * as THREE from 'three';
import { BLOCKS } from '../world/blocks.js';
import * as UIIcons from '../ui/icons.js';
import { mergeGeos } from './markers.js';

const _c = new THREE.Color();
let MAT = null;
const GEO = new Map();

/** Shared vertex-coloured material (slight emissive lift so pickups read at dusk). */
export function pickupMaterial() {
  if (!MAT) MAT = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(0x262626) });
  return MAT;
}

/** Non-indexed coloured box with baked per-face shading (top bright, bottom dark). */
export function vbox(w, h, d, color, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  _c.set(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const nrm = g.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const ny = nrm[i * 3 + 1], nx = nrm[i * 3];
    const s = ny > 0.5 ? 1.1 : ny < -0.5 ? 0.6 : Math.abs(nx) > 0.5 ? 0.84 : 0.96;
    col[i * 3] = Math.min(1, _c.r * s); col[i * 3 + 1] = Math.min(1, _c.g * s); col[i * 3 + 2] = Math.min(1, _c.b * s);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Extrude pixel-art rows (palette char -> colour) into voxel geometry. Rows are top-down; result faces +Z. */
export function pixelGeometry(rows, palette, px = 0.05, depth = 0.07) {
  const parts = [];
  const H = rows.length;
  let W = 0;
  for (const r of rows) W = Math.max(W, r.length);
  for (let y = 0; y < H; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const col = palette[row[x]];
      if (col === undefined || col === null) continue;
      parts.push(vbox(px, px, depth, col, (x - (W - 1) / 2) * px, ((H - 1) / 2 - y) * px, 0));
    }
  }
  return parts.length ? mergeGeos(parts) : null;
}

function cached(key, build) {
  let g = GEO.get(key);
  if (!g) { g = build(); GEO.set(key, g); }
  return g;
}

function meshOf(geo) {
  const m = new THREE.Mesh(geo, pickupMaterial());
  m.castShadow = false;
  return m;
}

// ------------------------------------------------------------------------------------------------ models

function cashGeometry() {
  const parts = [];
  const green = 0x3d8c3a, dark = 0x2c6b2a, band = 0xece3bf;
  const bundle = (y, rot, ox, oz) => {
    const p = [vbox(0.5, 0.075, 0.24, green), vbox(0.5, 0.012, 0.22, dark, 0, 0.04, 0), vbox(0.085, 0.09, 0.255, band)];
    for (const g of p) { g.rotateY(rot); g.translate(ox, y, oz); parts.push(g); }
  };
  bundle(-0.1, 0.08, 0, 0);
  bundle(-0.02, -0.12, 0.02, 0.03);
  bundle(0.06, 0.32, -0.02, -0.01);
  bundle(0.14, -0.05, 0.01, 0.0);
  return mergeGeos(parts);
}

const HEART = [
  '.kk...kk.',
  'kRRk.kRRk',
  'kRWRkRRRk',
  'kRRRRRRRk',
  '.kRRRRRk.',
  '..kRRRk..',
  '...kRk...',
  '....k....',
];
function heartGeometry() {
  return pixelGeometry(HEART, { k: 0x7d1018, R: 0xe5312f, W: 0xffffff }, 0.075, 0.12);
}

function armorGeometry() {
  const blue = 0x2f63c8, dark = 0x1e3f86, strap = 0x23272e, plate = 0x3b78e6;
  return mergeGeos([
    vbox(0.46, 0.44, 0.18, blue, 0, -0.04, 0),
    vbox(0.11, 0.14, 0.18, blue, -0.17, 0.24, 0),
    vbox(0.11, 0.14, 0.18, blue, 0.17, 0.24, 0),
    vbox(0.36, 0.2, 0.03, plate, 0, 0.0, 0.1),
    vbox(0.12, 0.09, 0.03, dark, -0.11, -0.18, 0.105),
    vbox(0.12, 0.09, 0.03, dark, 0.11, -0.18, 0.105),
    vbox(0.47, 0.05, 0.19, strap, 0, -0.1, 0),
    vbox(0.1, 0.03, 0.035, 0xf5c518, 0, 0.06, 0.12),
  ]);
}

function ammoGeometry() {
  const olive = 0x4b5a2a, lid = 0x5f7136, brass = 0xd8a93a, tip = 0xb5653a;
  const parts = [vbox(0.42, 0.22, 0.26, olive, 0, -0.06, 0), vbox(0.44, 0.05, 0.28, lid, 0, 0.05, 0), vbox(0.12, 0.05, 0.02, 0xd9d2a0, 0, -0.04, 0.135)];
  for (let i = 0; i < 4; i++) {
    const x = -0.12 + i * 0.08;
    parts.push(vbox(0.055, 0.12, 0.055, brass, x, 0.14, 0));
    parts.push(vbox(0.04, 0.05, 0.04, tip, x, 0.225, 0));
  }
  return mergeGeos(parts);
}

function packageGeometry() {
  const card = 0xb8875a, tape = 0xe6d3a3, mark = 0xc0392b;
  return mergeGeos([
    vbox(0.46, 0.4, 0.46, card),
    vbox(0.47, 0.41, 0.09, tape),
    vbox(0.09, 0.41, 0.47, tape),
    vbox(0.16, 0.06, 0.02, mark, 0.12, -0.1, 0.235),
  ]);
}

/** Atlas-textured cube for a block id (falls back to a vertex-coloured cube). */
function blockGeometry(game, id) {
  const def = BLOCKS[id] || BLOCKS[1];
  const tex = game && game.world && game.world.textures;
  if (tex && tex.atlasTexture && typeof tex.uvFor === 'function') {
    const g = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const uv = g.attributes.uv;
    // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 vertices each)
    const names = [def.tex.side, def.tex.side, def.tex.top, def.tex.bottom, def.tex.side, def.tex.side];
    for (let f = 0; f < 6; f++) {
      let r = null;
      try { r = tex.uvFor(names[f]); } catch (e) { r = null; }
      if (!r) continue;
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
      }
    }
    uv.needsUpdate = true;
    return { geo: g, textured: true };
  }
  return { geo: vbox(0.42, 0.42, 0.42, def.color || 0x888888), textured: false };
}

let _blockMat = null;
let _blockMatAtlas = null;
function blockMaterial(game) {
  const atlas = game && game.world && game.world.textures && game.world.textures.atlasTexture;
  if (!_blockMat || _blockMatAtlas !== atlas) {
    _blockMatAtlas = atlas;
    _blockMat = new THREE.MeshLambertMaterial({ map: atlas || null, alphaTest: 0.2, side: THREE.DoubleSide, emissive: new THREE.Color(0x202020) });
  }
  return _blockMat;
}

// ---- weapons

const PAL = {
  k: 0x17181c, d: 0x353941, m: 0x585f6a, l: 0x8a939f, h: 0xcdd5de, w: 0x5a3a1e, W: 0x94643a, y: 0xc48d52,
  b: 0x3e2a1a, r: 0xa5281e, R: 0xe5533f, g: 0x3f5a26, G: 0x68873f, o: 0x26351a, s: 0xe3b07a, S: 0xb27b47,
  c: 0x55c8f5, f: 0xf3a21b,
};

function spriteWeaponGeometry(id) {
  const sprites = UIIcons && UIIcons.SPRITES;
  const rows = sprites && (sprites[id] || sprites.pistol);
  if (rows) {
    const g = pixelGeometry(rows, PAL, 0.05, 0.08);
    if (g) return g;
  }
  // last resort: a generic blocky gun
  return mergeGeos([
    vbox(0.6, 0.12, 0.08, 0x353941, 0.05, 0.06, 0),
    vbox(0.12, 0.24, 0.08, 0x3e2a1a, -0.15, -0.1, 0),
    vbox(0.5, 0.04, 0.085, 0x8a939f, 0.08, 0.13, 0),
  ]);
}

/** Normalise an Object3D: centre it and scale its largest dimension to `size`. */
function fit(obj, size) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return obj;
  const sz = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const k = size / Math.max(1e-3, sz.x, sz.y, sz.z);
  const wrap = new THREE.Group();
  obj.position.sub(ctr);
  wrap.add(obj);
  wrap.scale.setScalar(k);
  return wrap;
}

function weaponModel(game, id) {
  let obj = null;
  const combat = game && game.combat;
  if (combat && typeof combat.getWeaponViewModel === 'function') {
    try {
      const src = combat.getWeaponViewModel(id);
      if (src && src.isObject3D) {
        obj = src.clone(true);
        obj.position.set(0, 0, 0);
        obj.rotation.set(0, 0, 0);
        obj.traverse((o) => { o.renderOrder = 0; o.frustumCulled = true; o.castShadow = false; });
      }
    } catch (e) { obj = null; }
  }
  if (obj) {
    // view models point +Z: lay the gun sideways so the spin shows its profile
    const g = new THREE.Group();
    obj.rotation.y = Math.PI / 2;
    g.add(obj);
    return fit(g, 0.8);
  }
  const m = meshOf(cached('weapon:' + id, () => spriteWeaponGeometry(id)));
  return fit(m, id === 'grenade' ? 0.45 : 0.8);
}

/**
 * Build the model for a pickup kind: 'cash' | 'health' | 'armor' | 'weapon' | 'ammo' | 'block' | 'package'.
 * sub = weapon id / block id. Returns an Object3D centred on the origin.
 */
export function buildPickupModel(game, kind, sub) {
  switch (kind) {
    case 'cash': return meshOf(cached('cash', cashGeometry));
    case 'health': return meshOf(cached('health', heartGeometry));
    case 'armor': return meshOf(cached('armor', armorGeometry));
    case 'ammo': return meshOf(cached('ammo', ammoGeometry));
    case 'package': return meshOf(cached('package', packageGeometry));
    case 'weapon': return weaponModel(game, sub);
    case 'block': {
      const id = Number(sub) | 0;
      const atlas = game && game.world && game.world.textures && game.world.textures.atlasTexture;
      const key = 'block:' + id + (atlas ? ':t' : ':c');
      const g = cached(key, () => blockGeometry(game, id).geo);
      const m = new THREE.Mesh(g, atlas ? blockMaterial(game) : pickupMaterial());
      // crates of TNT / blocks: show a little stack for bigger amounts
      return m;
    }
    default: return meshOf(cached('package', packageGeometry));
  }
}

/** Glow colour per pickup kind ('#rrggbb'). */
export const PICKUP_COLORS = {
  cash: '#5ee35a',
  health: '#ff4d5e',
  armor: '#4d9bff',
  weapon: '#ffb02e',
  ammo: '#e8c94a',
  block: '#ffffff',
  package: '#ffd23f',
};
