// Procedural block texture atlas (WORLD-ENGINE, see ARCHITECTURE.md §World).
//
//   const tex = new TextureAtlas();      // layout only (pure; safe in node, safe before init)
//   tex.init(renderer?)                   // paints every tile + builds the THREE.DataTexture (gutters + mip chain)
//   tex.atlasTexture                      // THREE.Texture: magFilter Nearest, sRGB, custom per-tile mipmaps
//   tex.uvFor(name, variant = 0)          // {u0, v0, u1, v1}: (u0,v0) = bottom-left of the upright tile, (u1,v1) top-right
//   tex.getIcon(blockId)                  // cached 48x48 isometric icon canvas (browser only, null in node)
//   tex.getIconURL(blockId)               // cached data: URL of that icon
//   tex.getColor(blockId)                 // 0xRRGGBB average block colour
//   tex.update(dt, renderer)              // animates the water tile (sub-image copies, no full re-upload)
//
// Layout: 16 columns of 32x32 cells; each cell holds a 16x16 tile surrounded by an 8 px wrap-around gutter, so every
// mip level down to 1 px per tile samples only its own tile (no bleeding, seamless block-to-block filtering).
// Mining crack overlays 'destroy_0'..'destroy_9' are included (transparent tiles, used by Player).
import * as THREE from 'three';
import { BLOCKS, allTextureNames } from './blocks.js';
import { PixelTile, buildCellMips, downsample, toHex } from './engine_pixels.js';
import {
  paintTexture, paintWaterFrame, TEXTURE_VARIANTS, WATER_FRAMES, DESTROY_STAGES,
} from './engine_painters.js';

const TILE = 16;
const GUTTER = 8;
const CELL = TILE + GUTTER * 2;
const COLS = 16;
const ICON = 48;
const WATER_FPS = 7;

const nextPow2 = (v) => { let p = 1; while (p < v) p *= 2; return p; };

/** Block colour hint for a texture name (for the fallback painter). */
function colorHintFor(name) {
  for (const d of BLOCKS) {
    if (!d || d.id === 0) continue;
    if (d.tex.top === name || d.tex.side === name || d.tex.bottom === name) return d.color;
  }
  return 0x888888;
}

/** Texture names that are alpha-tested (cutout) in the world: coverage is preserved across mip levels. */
function cutoutNames() {
  const s = new Set();
  for (const d of BLOCKS) {
    if (!d || d.id === 0) continue;
    if (d.cutout || d.shape === 'cross') { s.add(d.tex.top); s.add(d.tex.side); s.add(d.tex.bottom); }
  }
  return s;
}

export class TextureAtlas {
  constructor() {
    this.tileSize = TILE;
    this.gutter = GUTTER;
    this.cellSize = CELL;
    this.cols = COLS;
    /** THREE.DataTexture once init() ran, else null. */
    this.atlasTexture = null;
    this.ready = false;
    this.entries = [];          // [{key, name, variant, col, row, rect}]
    this._byKey = new Map();    // 'name#v' -> entry
    this._variants = new Map(); // name -> count
    this._tiles = new Map();    // key -> PixelTile (lazy)
    this._icons = new Map();
    this._iconURLs = new Map();
    this._avg = new Map();
    this._water = null;
    this._waterT = 0;
    this._waterFrame = 0;
    this._layout();
  }

  _layout() {
    const names = [];
    const seen = new Set();
    const addName = (n) => { if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
    for (const n of allTextureNames()) addName(n);
    for (let i = 0; i < DESTROY_STAGES; i++) addName('destroy_' + i);
    addName('missing');
    for (const name of names) {
      const nv = Math.max(1, TEXTURE_VARIANTS[name] || 1);
      this._variants.set(name, nv);
      for (let v = 0; v < nv; v++) {
        const k = this.entries.length;
        const e = { key: name + '#' + v, name, variant: v, index: k, col: k % COLS, row: Math.floor(k / COLS), rect: null };
        this.entries.push(e);
        this._byKey.set(e.key, e);
      }
    }
    this.rows = nextPow2(Math.ceil(this.entries.length / COLS));
    this.width = COLS * CELL;
    this.height = this.rows * CELL;
    for (const e of this.entries) {
      const x0 = e.col * CELL + GUTTER, y0 = e.row * CELL + GUTTER; // image space (y down)
      e.rect = Object.freeze({
        u0: x0 / this.width,
        u1: (x0 + TILE) / this.width,
        v0: 1 - (y0 + TILE) / this.height, // bottom edge of the upright tile
        v1: 1 - y0 / this.height,          // top edge
      });
    }
    this._missing = this._byKey.get('missing#0');
  }

  /** Number of visual variants of a texture name (1 for most). */
  variantCount(name) { return this._variants.get(name) || 1; }

  /** True if the atlas has a tile for this name. */
  has(name) { return this._variants.has(name); }

  /** UV rect {u0,v0,u1,v1} of a tile; unknown names map to a neutral fallback tile. */
  uvFor(name, variant = 0) {
    const nv = this._variants.get(name);
    if (!nv) return this._missing.rect;
    const e = this._byKey.get(name + '#' + (((variant % nv) + nv) % nv));
    return e ? e.rect : this._missing.rect;
  }

  /** Level-0 pixels of a tile (PixelTile 16x16, sRGB RGBA). Painted lazily, so usable before init(). */
  tilePixels(name, variant = 0) {
    const nv = this._variants.get(name);
    const key = nv ? name + '#' + (variant % nv) : 'missing#0';
    let t = this._tiles.get(key);
    if (!t) {
      const e = this._byKey.get(key);
      t = paintTexture(e ? e.name : 'missing', e ? e.variant : 0, colorHintFor(e ? e.name : name));
      this._tiles.set(key, t);
    }
    return t;
  }

  /** Average colour (0xRRGGBB) of a texture's visible pixels. */
  averageColor(name) {
    if (this._avg.has(name)) return this._avg.get(name);
    const c = toHex(this.tilePixels(name).average());
    this._avg.set(name, c);
    return c;
  }

  /** Average colour of a block (0xRRGGBB); the registry colour. */
  getColor(blockId) {
    const d = BLOCKS[blockId];
    return d ? d.color : 0x888888;
  }

  /** Build every tile and the GPU texture. renderer (optional) is used for the anisotropy level. */
  init(renderer) {
    if (this.ready) return this;
    const cut = cutoutNames();
    const W = this.width, H = this.height;
    const nLevels = Math.floor(Math.log2(Math.max(W, H))) + 1;
    const cellLevels = Math.log2(CELL) + 1; // levels where a cell is >= 1 px
    const levels = [];
    for (let L = 0; L < nLevels; L++) {
      const w = Math.max(1, W >> L), h = Math.max(1, H >> L);
      levels.push({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    }
    // per-cell mip chains composed into the atlas levels
    for (const e of this.entries) {
      const tile = this.tilePixels(e.name, e.variant);
      const mips = buildCellMips(tile, GUTTER, cut.has(e.name));
      for (let L = 0; L < cellLevels && L < nLevels; L++) {
        const m = mips[L], lv = levels[L];
        const ox = (e.col * CELL) >> L, oy = (e.row * CELL) >> L;
        for (let y = 0; y < m.size; y++) {
          lv.data.set(m.data.subarray(y * m.size * 4, (y + 1) * m.size * 4), ((oy + y) * lv.width + ox) * 4);
        }
      }
    }
    for (let L = cellLevels; L < nLevels; L++) {
      const prev = levels[L - 1];
      const d = downsample(prev.data, prev.width, prev.height);
      levels[L] = { data: d.data, width: d.width, height: d.height };
    }
    this._image = { data: levels[0].data.slice(), width: W, height: H }; // upright copy for debugging
    // flip rows: GL texture row 0 = bottom of the image (so v grows upward like any three.js texture)
    const mipmaps = levels.map((lv) => ({ data: flipRows(lv.data, lv.width, lv.height), width: lv.width, height: lv.height }));
    const tex = new THREE.DataTexture(mipmaps[0].data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.mipmaps = mipmaps;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.name = 'blockAtlas';
    let aniso = 1;
    try { aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1; } catch (e) { aniso = 1; }
    tex.anisotropy = Math.max(1, Math.min(8, aniso || 1));
    tex.needsUpdate = true;
    this.atlasTexture = tex;
    this._buildWaterFrames();
    this.ready = true;
    return this;
  }

  _buildWaterFrames() {
    const e = this._byKey.get('water#0');
    if (!e) return;
    const frames = [];
    for (let f = 0; f < WATER_FRAMES; f++) {
      const t = new PixelTile(TILE, TILE);
      paintWaterFrame(t, f);
      const mips = buildCellMips(t, GUTTER, false);
      const lvls = [];
      for (let L = 0; L < mips.length; L++) {
        const m = mips[L];
        const data = flipRows(m.data, m.size, m.size);
        const dt = new THREE.DataTexture(data, m.size, m.size, THREE.RGBAFormat, THREE.UnsignedByteType);
        const lvH = Math.max(1, this.height >> L);
        lvls.push({ tex: dt, pos: new THREE.Vector2((e.col * CELL) >> L, lvH - ((e.row * CELL) >> L) - m.size) });
      }
      frames.push(lvls);
    }
    this._water = frames;
  }

  /** Animate the water tile (call once per frame with the renderer). Cheap: a few small texSubImage2D calls. */
  update(dt, renderer) {
    if (!this.ready || !this._water || !renderer || typeof renderer.copyTextureToTexture !== 'function') return;
    this._waterT += dt;
    if (this._waterT < 1 / WATER_FPS) return;
    this._waterT %= 1 / WATER_FPS;
    this._waterFrame = (this._waterFrame + 1) % this._water.length;
    const fr = this._water[this._waterFrame];
    try {
      for (let L = 0; L < fr.length; L++) renderer.copyTextureToTexture(fr[L].pos, fr[L].tex, this.atlasTexture, L);
    } catch (e) {
      this._water = null; // unsupported: keep the static water tile
    }
  }

  /** Raw RGBA pixels (48x48) of the isometric icon of a block. Pure; used by getIcon. */
  iconPixels(blockId) {
    const def = BLOCKS[blockId];
    const out = new Uint8ClampedArray(ICON * ICON * 4);
    if (!def || blockId === 0) return out;
    if (def.shape === 'cross') {
      const t = this.tilePixels(def.tex.side);
      const s = ICON / TILE;
      for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
          const i = t.idx(Math.floor(x / s), Math.floor(y / s)), o = (y * ICON + x) * 4;
          out[o] = t.data[i]; out[o + 1] = t.data[i + 1]; out[o + 2] = t.data[i + 2]; out[o + 3] = t.data[i + 3];
        }
      }
      return out;
    }
    const top = this.tilePixels(def.tex.top), side = this.tilePixels(def.tex.side);
    // 2:1 isometric cube: top rhombus T(24,2) R(46,13) B(24,24) L(2,13); sides 22 px tall
    const put = (o, t, u, v, shade) => {
      const tx = Math.min(15, Math.max(0, Math.floor(u * TILE))), ty = Math.min(15, Math.max(0, Math.floor(v * TILE)));
      const i = t.idx(tx, ty);
      const a = t.data[i + 3];
      if (a === 0) return false;
      out[o] = t.data[i] * shade; out[o + 1] = t.data[i + 1] * shade; out[o + 2] = t.data[i + 2] * shade;
      out[o + 3] = def.transparent ? Math.max(a, 90) : 255; // (alpha < 255 on emissive tiles is a glow mask)
      return true;
    };
    for (let py = 0; py < ICON; py++) {
      for (let px = 0; px < ICON; px++) {
        const X = px + 0.5, Y = py + 0.5;
        const o = (py * ICON + px) * 4;
        // top face
        const a = (Y - 2) / 11, b = (X - 24) / 22;
        const s = (a + b) / 2, t = (a - b) / 2;
        if (s >= 0 && s <= 1 && t >= 0 && t <= 1) { if (put(o, top, s, t, 1.0)) continue; }
        // left face (front-left, lit)
        const ls = (X - 2) / 22, lt = (Y - 13 - 11 * ls) / 22;
        if (ls >= 0 && ls <= 1 && lt >= 0 && lt <= 1) { if (put(o, side, ls, lt, 0.8)) continue; }
        // right face (front-right, shaded)
        const rs = (X - 24) / 22, rt = (Y - 24 + 11 * rs) / 22;
        if (rs >= 0 && rs <= 1 && rt >= 0 && rt <= 1) put(o, side, rs, rt, 0.62);
      }
    }
    return out;
  }

  /** Cached 48x48 isometric icon canvas for a block (HUD hotbar / inventory / shop). null outside the browser. */
  getIcon(blockId) {
    if (this._icons.has(blockId)) return this._icons.get(blockId);
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = ICON; c.height = ICON;
    c.className = 'block-icon';
    try {
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(ICON, ICON);
      img.data.set(this.iconPixels(blockId));
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* canvas unavailable: blank icon */ }
    this._icons.set(blockId, c);
    return c;
  }

  /** Cached data: URL of the block icon (handy for <img> / CSS backgrounds; '' outside the browser). */
  getIconURL(blockId) {
    if (this._iconURLs.has(blockId)) return this._iconURLs.get(blockId);
    const c = this.getIcon(blockId);
    let url = '';
    try { url = c ? c.toDataURL() : ''; } catch (e) { url = ''; }
    this._iconURLs.set(blockId, url);
    return url;
  }

  /** Upright level-0 atlas as a (cached) canvas, for UI code that wants to draw tiles itself. null in node. */
  get atlasCanvas() {
    if (!this._canvas) this._canvas = this.toCanvas(1);
    return this._canvas;
  }

  /** Upright level-0 atlas as a new canvas (optionally scaled), or null outside the browser / before init. */
  toCanvas(scale = 1) {
    if (!this._image || typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = this.width * scale; c.height = this.height * scale;
    const src = document.createElement('canvas');
    src.width = this.width; src.height = this.height;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(this.width, this.height);
    img.data.set(this._image.data);
    sctx.putImageData(img, 0, 0);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  dispose() {
    if (this.atlasTexture) this.atlasTexture.dispose();
    if (this._water) for (const fr of this._water) for (const l of fr) l.tex.dispose();
    this.atlasTexture = null;
    this.ready = false;
  }
}

/** Alias (the contract only names the module): `new Textures()` works too. */
export { TextureAtlas as Textures };

function flipRows(src, w, h) {
  const out = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(src.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}
