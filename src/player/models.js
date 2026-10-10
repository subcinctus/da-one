// Procedural voxel models for held items: tools (pickaxe/axe/shovel), block items (atlas-textured cubes / crossed
// plant quads), the first-person arm and a fallback gun. Two "contexts":
//   'world' - third-person hand (humanoid.setHeld): normal lit materials.
//   'vm'    - first-person view model: materials are transparent-pass (rendered last, after a depth clear) with no fog.
import * as THREE from 'three';
import { BLOCKS } from '../world/blocks.js';
import { WEAPONS } from '../data/weapons.js';
import { LOOKS } from '../entities/humanoid.js';
import { itemKey } from '../data/items.js';

export const VM_RENDER_ORDER = 1001;

const _c = new THREE.Color();

/** Non-indexed box geometry with flat vertex colour + baked face shading. Dimensions in metres. */
export function colorBox(w, h, d, color, ox = 0, oy = 0, oz = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(ox, oy, oz);
  _c.set(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const nrm = g.attributes.normal.array;
  for (let i = 0; i < n; i++) {
    const ny = nrm[i * 3 + 1], nx = nrm[i * 3];
    const shade = ny > 0.5 ? 1.1 : ny < -0.5 ? 0.62 : Math.abs(nx) > 0.5 ? 0.86 : 0.97;
    col[i * 3] = Math.min(1, _c.r * shade); col[i * 3 + 1] = Math.min(1, _c.g * shade); col[i * 3 + 2] = Math.min(1, _c.b * shade);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Merge non-indexed geometries with position/normal/color into one. Disposes the inputs. */
export function mergeColored(geos) {
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

const WOOD = 0x7a5230, WOOD_DARK = 0x5b3b20, IRON = 0xb8c0c6, IRON_DARK = 0x7d868d, IRON_EDGE = 0xe3e8eb;

/**
 * Tool geometry in the canonical tool frame: grip at the origin, handle along +Y, head at the top,
 * blade plane = XY (thin along Z).
 */
export function toolGeometry(id) {
  const parts = [];
  if (id === 'axe') {
    parts.push(colorBox(0.05, 0.64, 0.05, WOOD, 0, 0.24, 0));
    parts.push(colorBox(0.055, 0.05, 0.055, WOOD_DARK, 0, -0.06, 0));
    parts.push(colorBox(0.07, 0.11, 0.07, IRON_DARK, 0, 0.5, 0));            // eye
    parts.push(colorBox(0.11, 0.17, 0.035, IRON, 0.085, 0.49, 0));           // blade
    parts.push(colorBox(0.03, 0.21, 0.03, IRON_EDGE, 0.15, 0.49, 0));        // cutting edge
    parts.push(colorBox(0.05, 0.07, 0.05, IRON_DARK, -0.055, 0.5, 0));       // poll
  } else if (id === 'shovel') {
    parts.push(colorBox(0.045, 0.62, 0.045, WOOD, 0, 0.25, 0));
    parts.push(colorBox(0.11, 0.04, 0.05, WOOD_DARK, 0, -0.07, 0));          // D-grip
    parts.push(colorBox(0.06, 0.06, 0.05, IRON_DARK, 0, 0.58, 0));           // socket
    parts.push(colorBox(0.15, 0.18, 0.03, IRON, 0, 0.7, 0));                 // spade
    parts.push(colorBox(0.09, 0.04, 0.03, IRON_EDGE, 0, 0.81, 0));           // tip
  } else {
    // pickaxe (default)
    parts.push(colorBox(0.05, 0.66, 0.05, WOOD, 0, 0.25, 0));
    parts.push(colorBox(0.055, 0.05, 0.055, WOOD_DARK, 0, -0.07, 0));
    parts.push(colorBox(0.11, 0.08, 0.07, IRON_DARK, 0, 0.58, 0));           // centre
    for (const s of [-1, 1]) {
      parts.push(colorBox(0.12, 0.06, 0.055, IRON, s * 0.11, 0.575, 0));
      parts.push(colorBox(0.08, 0.055, 0.05, IRON, s * 0.2, 0.545, 0));
      parts.push(colorBox(0.05, 0.05, 0.045, IRON_EDGE, s * 0.26, 0.51, 0)); // pointed tips curve down
    }
  }
  return mergeColored(parts);
}

/** Simple voxel pistol/rifle used when Combat provides no model. Points +Z, grip near the origin. */
export function fallbackWeaponGeometry(id) {
  const def = WEAPONS[id] || {};
  const parts = [];
  const black = 0x26282b, dark = 0x3a3d42, wood = 0x6b4a2b;
  if (def.kind === 'melee') {
    parts.push(colorBox(0.05, 0.05, 0.75, wood, 0, 0, 0.3));
    parts.push(colorBox(0.075, 0.075, 0.35, 0x8a6a42, 0, 0, 0.5));
    return mergeColored(parts);
  }
  if (def.kind === 'throw') {
    parts.push(colorBox(0.09, 0.11, 0.09, 0x3d5a2a, 0, 0, 0.04));
    parts.push(colorBox(0.03, 0.04, 0.03, 0x999999, 0, 0.07, 0.04));
    return mergeColored(parts);
  }
  const long = id === 'rifle' || id === 'sniper' || id === 'shotgun' || id === 'rpg';
  const len = id === 'pistol' ? 0.22 : long ? 0.75 : 0.42;
  parts.push(colorBox(0.06, 0.09, len, black, 0, 0.04, len * 0.35));         // receiver
  parts.push(colorBox(0.035, 0.035, len * 0.5, dark, 0, 0.06, len * 0.8));   // barrel
  parts.push(colorBox(0.05, 0.12, 0.06, dark, 0, -0.05, 0));                 // grip
  if (long) parts.push(colorBox(0.055, 0.1, 0.22, id === 'shotgun' ? wood : black, 0, 0.0, -0.12)); // stock
  if (id === 'sniper') parts.push(colorBox(0.05, 0.05, 0.22, 0x111111, 0, 0.12, len * 0.35));      // scope
  if (id === 'rpg') parts.push(colorBox(0.11, 0.11, 0.9, 0x4a5a32, 0, 0.06, 0.3));
  return mergeColored(parts);
}

/** First-person arm (camera space: extends along -Z, hand at the far end). */
export function armGeometry(look = LOOKS.player) {
  const skin = look.skin || 0xe0ac69, shirt = look.shirt || 0x2e7d32;
  return mergeColored([
    colorBox(0.13, 0.13, 0.36, skin, 0, 0, -0.18),
    colorBox(0.14, 0.14, 0.2, shirt, 0, 0, 0.08),
  ]);
}

/** Small fist (skin cube) used under held weapons in first person. */
export function handGeometry(look = LOOKS.player) {
  return mergeColored([colorBox(0.11, 0.11, 0.14, look.skin || 0xe0ac69, 0, 0, 0)]);
}

// ---------------------------------------------------------------------------------------------- block items

const FACE_TEX = ['side', 'side', 'top', 'bottom', 'side', 'side']; // BoxGeometry groups: +x -x +y -y +z -z

/** Remap a BoxGeometry/PlaneGeometry face's 0..1 UVs into an atlas rect. */
function remapUV(uv, start, count, r) {
  for (let i = start; i < start + count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
  }
}

/** Unit cube (centred) textured from the atlas for block `id`; null when the atlas is unavailable. */
export function blockCubeGeometry(textures, id) {
  const def = BLOCKS[id];
  if (!def || !textures || typeof textures.uvFor !== 'function') return null;
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const r = textures.uvFor(def.tex[FACE_TEX[f]]);
    if (!r) { g.dispose(); return null; }
    remapUV(uv, f * 4, 4, r);
  }
  uv.needsUpdate = true;
  return g;
}

/** Two crossed quads for plant blocks (centred unit size). */
export function plantGeometry(textures, id) {
  const def = BLOCKS[id];
  if (!def || !textures || typeof textures.uvFor !== 'function') return null;
  const r = textures.uvFor(def.tex.side);
  if (!r) return null;
  const a = new THREE.PlaneGeometry(1, 1); a.rotateY(Math.PI / 4);
  const b = new THREE.PlaneGeometry(1, 1); b.rotateY(-Math.PI / 4);
  remapUV(a.attributes.uv, 0, 4, r); remapUV(b.attributes.uv, 0, 4, r);
  const pos = new Float32Array(24), nor = new Float32Array(24), uvs = new Float32Array(16);
  pos.set(a.attributes.position.array, 0); pos.set(b.attributes.position.array, 12);
  nor.set(a.attributes.normal.array, 0); nor.set(b.attributes.normal.array, 12);
  uvs.set(a.attributes.uv.array, 0); uvs.set(b.attributes.uv.array, 8);
  const idx = [0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  a.dispose(); b.dispose();
  return g;
}

/** Flat-coloured cube for a block (fallback without the atlas). */
export function blockColorGeometry(textures, id) {
  const def = BLOCKS[id] || BLOCKS[0];
  let col = def.color;
  try { const c = textures && textures.getColor && textures.getColor(id); if (c !== undefined && c !== null) col = c; } catch (e) { /* ignore */ }
  if (def.tex.top !== def.tex.side && id === 4) { // grass: green top, dirt sides
    return mergeColored([colorBox(1, 0.2, 1, 0x5d9b3a, 0, 0.4, 0), colorBox(1, 0.8, 1, 0x86603c, 0, -0.1, 0)]);
  }
  return mergeColored([colorBox(1, 1, 1, col)]);
}

// ---------------------------------------------------------------------------------------------- factory

/**
 * Builds + caches Object3Ds for inventory items. One cached instance per (context, itemKey) since an Object3D
 * has a single parent: the third-person hand and the first-person holder each get their own.
 */
export class ItemModels {
  constructor(game) {
    this.game = game;
    this._cache = { world: new Map(), vm: new Map() };
    this._toolGeo = new Map();
    this._blockGeo = new Map();
    this._mats = {};
    this._atlasRef = null;
  }

  _textures() { return this.game.world && this.game.world.textures; }

  /** Shared materials per context (atlas / vertex colours). */
  mat(ctx, kind) {
    const tex = this._textures();
    const atlas = tex && tex.atlasTexture;
    if (atlas !== this._atlasRef) { this._atlasRef = atlas; this._mats = {}; } // atlas (re)built: drop stale materials
    const key = ctx + ':' + kind;
    if (this._mats[key]) return this._mats[key];
    const vm = ctx === 'vm';
    const base = vm ? { transparent: true, depthTest: true, depthWrite: true, fog: false } : {};
    let m;
    if (kind === 'color') m = new THREE.MeshLambertMaterial({ vertexColors: true, ...base });
    else if (kind === 'emissive') m = new THREE.MeshBasicMaterial({ map: atlas, ...base, alphaTest: 0.1 });
    else if (kind === 'cutout') m = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, ...base });
    else if (kind === 'glass') m = new THREE.MeshLambertMaterial({ map: atlas, transparent: true, depthWrite: !vm ? false : true, fog: !vm });
    else m = new THREE.MeshLambertMaterial({ map: atlas, ...base, alphaTest: 0.1 });
    if (kind === 'cutout' && vm) m.forceSinglePass = true;
    this._mats[key] = m;
    return m;
  }

  /** Object3D for `item` in context 'world' | 'vm', or null for an empty hand. */
  get(item, ctx = 'world') {
    if (!item) return null;
    const key = itemKey(item);
    const cache = this._cache[ctx];
    let obj = cache.get(key);
    if (obj && obj.userData.atlas !== this._atlasRefFor(item)) { this._disposeObj(obj); obj = null; cache.delete(key); }
    if (!obj) {
      obj = this._build(item, ctx);
      if (obj) cache.set(key, obj);
    }
    return obj;
  }

  _atlasRefFor(item) {
    if (item.kind !== 'block') return undefined;
    const t = this._textures();
    return (t && t.atlasTexture) || null;
  }

  _build(item, ctx) {
    let obj = null;
    if (item.kind === 'tool') obj = this._buildTool(item.id, ctx);
    else if (item.kind === 'block') obj = this._buildBlock(item.id, ctx);
    else if (item.kind === 'weapon') obj = this._buildWeapon(item.id, ctx);
    if (obj) {
      obj.userData.kind = item.kind;
      obj.userData.atlas = this._atlasRefFor(item);
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = ctx === 'world';
        if (ctx === 'vm') { o.renderOrder = VM_RENDER_ORDER; o.frustumCulled = false; o.receiveShadow = false; }
      });
    }
    return obj;
  }

  _buildTool(id, ctx) {
    let g = this._toolGeo.get(id);
    if (!g) { g = toolGeometry(id); this._toolGeo.set(id, g); }
    const mesh = new THREE.Mesh(g, this.mat(ctx, 'color'));
    const root = new THREE.Group();
    if (ctx === 'world') {
      // hand socket: item +Z = down the arm, +Y = forward. Tilt the handle forward-up, grip in the fist.
      mesh.rotation.x = -0.8;
      mesh.position.set(0, 0.02, 0.02);
      root.userData.handle = true;
    }
    root.add(mesh);
    return root;
  }

  _blockGeometry(id) {
    const tex = this._textures();
    const key = id + (tex && tex.atlasTexture ? ':atlas' : ':flat');
    let g = this._blockGeo.get(key);
    if (g) return g;
    const def = BLOCKS[id];
    if (def && def.shape === 'cross') g = plantGeometry(tex, id);
    else g = blockCubeGeometry(tex, id);
    if (!g || !(tex && tex.atlasTexture)) { if (g) g.dispose(); g = blockColorGeometry(tex, id); g.userData.flat = true; }
    this._blockGeo.set(key, g);
    return g;
  }

  _buildBlock(id, ctx) {
    const def = BLOCKS[id] || BLOCKS[0];
    const g = this._blockGeometry(id);
    let kind = 'opaque';
    if (g.userData.flat) kind = 'color';
    else if (def.shape === 'cross' || def.cutout) kind = 'cutout';
    else if (def.transparent) kind = 'glass';
    else if (def.emissive) kind = 'emissive';
    const mesh = new THREE.Mesh(g, this.mat(ctx, kind));
    const root = new THREE.Group();
    if (ctx === 'world') {
      mesh.scale.setScalar(def.shape === 'cross' ? 0.32 : 0.24);
      mesh.position.set(0, 0.1, 0.06);
      mesh.rotation.set(0.2, 0.6, 0);
    }
    root.add(mesh);
    root.userData.cross = def.shape === 'cross';
    return root;
  }

  _buildWeapon(id, ctx) {
    let src = null;
    try { src = this.game.combat && typeof this.game.combat.getWeaponViewModel === 'function' ? this.game.combat.getWeaponViewModel(id) : null; } catch (e) { src = null; }
    let obj;
    if (src && src.isObject3D) {
      obj = src;
      if (ctx === 'vm') {
        // own the materials: transparent pass (after the depth clear), no fog; never mutate Combat's shared materials
        obj.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const conv = (m) => { const c = m.clone(); c.transparent = true; c.depthTest = true; c.depthWrite = true; c.fog = false; if (c.side === THREE.DoubleSide) c.forceSinglePass = true; return c; };
          o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
          o.userData.ownsMaterial = true;
        });
      }
    } else {
      obj = new THREE.Group();
      obj.add(new THREE.Mesh(fallbackWeaponGeometry(id), this.mat(ctx, 'color')));
      obj.userData.fallback = true;
    }
    const root = new THREE.Group();
    root.add(obj);
    return root;
  }

  _disposeObj(obj) {
    if (obj.parent) obj.parent.remove(obj);
    obj.traverse((o) => {
      if (o.isMesh && o.userData.ownsMaterial) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) m.dispose();
      }
    });
  }

  /** Drop cached models (e.g. after the atlas changed). */
  clear() {
    for (const ctx of ['world', 'vm']) {
      for (const obj of this._cache[ctx].values()) this._disposeObj(obj);
      this._cache[ctx].clear();
    }
  }
}
