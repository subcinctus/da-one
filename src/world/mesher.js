// Chunk mesher (WORLD-ENGINE). Pure: typed arrays in, typed arrays out (unit-testable in node, no THREE).
//
// A chunk (16 x 96 x 16) is meshed per vertical SECTION (16 high) from a padded neighbourhood copy
// (18 x 98 x 18: one extra block on every side, taken from the neighbouring chunks) so faces are culled
// correctly across chunk borders and ambient occlusion is seamless.
//
//   const T = buildTables(atlas)                         // per-block lookup tables (flags, UVs, variants, tints, lights)
//   const env = prepareEnv(createEnv(), getHeights, getLights, cx, cz, T)   // optional: sky exposure + block light
//   fillPad(pad, getData, cx, cz, y0, y1)                // copy the neighbourhood into `pad` (Uint8Array(PAD_LEN))
//   const part = meshSection(pad, s, T, wx0, wz0, env)   // -> { opaque, transparent, emissive:null } (Part or null)
//   const merged = mergeParts([part0.opaque, ...])       // -> { position, normal, color, uv, light, index, ... }
//
// Part = { quads, pos: Float32Array(q*12), nor: Int8Array(q*16), col: Uint8Array(q*16), uv: Float32Array(q*8),
//          lit: Uint8Array(q*16) (rgb = block light from lamps/neon, a = sky exposure), flip: Uint8Array(q), minY, maxY }
// Sky exposure: fraction of open-sky columns in a 5x5 neighbourhood at the cell's height (heightmap test), so covered
// spaces (interiors, tunnels, under bridges, mines) are darker while a lone lamp head casts no harsh shadow.
// Passes: opaque (incl. alpha-tested cutout leaves/plants AND emissive blocks: lit windows, lamps, neon, whose faces are
// flagged with light alpha 255 so the shader adds their night glow) and transparent (water, glass). The `emissive`
// output is kept for API stability and is always null.
// Lighting baked into vertex colours: classic 3-sample corner AO x per-face shade (top 1, N/S 0.8, E/W 0.65, bottom 0.5)
// x subtle per-block / biome tints. The quad diagonal is flipped to follow the AO gradient (no anisotropy artefacts).
import { BLOCKS } from './blocks.js';

export const CS = 16;          // chunk size x/z
export const CH = 96;          // chunk height
export const SECTION_H = 16;
export const SECTIONS = CH / SECTION_H;
export const PAD_X = CS + 2;
export const PAD_LAYER = PAD_X * PAD_X; // 324
export const PAD_Y = CH + 2;
export const PAD_LEN = PAD_LAYER * PAD_Y;
/** Index into the padded neighbourhood for chunk-local coords (x,z in -1..16, y in -1..96). */
export const padIndex = (x, y, z) => (x + 1) + (z + 1) * PAD_X + (y + 1) * PAD_LAYER;

// block flags
export const F_OPAQUE = 1;     // hides neighbour faces
export const F_AO = 2;         // casts ambient occlusion
export const F_CULLSAME = 4;   // faces between two blocks of the same id are skipped (water, glass)
export const F_LIQUID = 8;
export const F_CROSS = 16;
export const F_CUBE = 32;
export const F_EMISSIVE = 64;
export const F_TRANSP = 128;

// tint kinds
const T_JITTER = 1, T_GRASS = 2, T_FOLIAGE = 3, T_PLANT = 4; // 0 = none

export const MAX_VARIANTS = 4;
/** Perceptual -> linear exponent for baked lighting (vertex colours are multiplied in linear space). */
export const LIGHT_GAMMA = 2.0;
/** Per-face shade, face order: +X(E) -X(W) +Y(top) -Y(bottom) +Z(S) -Z(N). */
export const FACE_SHADE = [0.65, 0.65, 1.0, 0.5, 0.8, 0.8];
/** AO curve (perceptual brightness for 0..3 unoccluded samples). */
export const AO_CURVE = [0.52, 0.7, 0.85, 1.0];
const WATER_TOP = 0.875;

// face geometry: corners in CCW order seen from outside: bottom-left, bottom-right, top-right, top-left (texture upright)
const FACE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_C = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
const FACE_SLOT = ['side', 'side', 'top', 'bottom', 'side', 'side'];
const pd = (x, y, z) => x + z * PAD_X + y * PAD_LAYER;
/** Pad offset of the neighbour across each face. */
export const NOFF = FACE_N.map((n) => pd(n[0], n[1], n[2]));
/** AO sample offsets relative to the neighbour cell: [face][corner][side1, side2, corner]. */
const AOFF = new Int32Array(6 * 4 * 3);
for (let f = 0; f < 6; f++) {
  const n = FACE_N[f];
  const axes = [0, 1, 2].filter((a) => n[a] === 0);
  for (let c = 0; c < 4; c++) {
    const cc = FACE_C[f][c];
    const d = [0, 0, 0], e = [0, 0, 0];
    d[axes[0]] = cc[axes[0]] ? 1 : -1;
    e[axes[1]] = cc[axes[1]] ? 1 : -1;
    const o = (f * 4 + c) * 3;
    AOFF[o] = pd(d[0], d[1], d[2]);
    AOFF[o + 1] = pd(e[0], e[1], e[2]);
    AOFF[o + 2] = pd(d[0] + e[0], d[1] + e[1], d[2] + e[2]);
  }
}
const FACE_CF = new Float32Array(6 * 12);
for (let f = 0; f < 6; f++) for (let c = 0; c < 4; c++) for (let a = 0; a < 3; a++) FACE_CF[f * 12 + c * 3 + a] = FACE_C[f][c][a];
const FACE_NI = new Int8Array(6 * 3);
for (let f = 0; f < 6; f++) for (let a = 0; a < 3; a++) FACE_NI[f * 3 + a] = FACE_N[f][a] * 127;

// light table: perceptual (shade * ao) -> linear byte, [face][ao]; and the softer emissive variant
const LIGHT = new Float32Array(6 * 4);
const LIGHT_EMI = new Float32Array(6);
for (let f = 0; f < 6; f++) {
  for (let a = 0; a < 4; a++) LIGHT[f * 4 + a] = 255 * Math.pow(FACE_SHADE[f] * AO_CURVE[a], LIGHT_GAMMA);
  LIGHT_EMI[f] = 255 * Math.pow(0.78 + 0.22 * FACE_SHADE[f], LIGHT_GAMMA);
}

/**
 * Per-block lookup tables. `atlas` needs uvFor(name, variant) and variantCount(name) (TextureAtlas).
 * Works without an atlas (UVs all zero) so the mesher can be tested standalone.
 */
export function buildTables(atlas) {
  const flags = new Uint8Array(256);
  const tint = new Uint8Array(256);
  const rot = new Uint8Array(256);
  const uv = new Float32Array(256 * 6 * MAX_VARIANTS * 4);
  const nvar = new Uint8Array(256 * 6);
  const solid = new Uint8Array(256);
  const lightR = new Float32Array(256);
  const lightCol = new Float32Array(256 * 3);
  const JITTER = new Set(['STONE', 'DIRT', 'SAND', 'GRAVEL', 'COBBLESTONE', 'SNOW', 'BEDROCK', 'SANDSTONE', 'TERRACOTTA',
    'COAL_ORE', 'IRON_ORE', 'GOLD_ORE', 'DIAMOND_ORE', 'LOG', 'PALM_LOG', 'HEDGE', 'ROOF', 'ASPHALT']);
  const ROTATE = new Set(['GRASS', 'DIRT', 'SAND', 'GRAVEL', 'SNOW', 'STONE', 'BEDROCK', 'LEAVES', 'HEDGE', 'ASPHALT', 'ROOF']);
  for (const d of BLOCKS) {
    if (!d || d.id === 0 || d.id > 255) continue;
    const id = d.id;
    let f = 0;
    if (d.solid) solid[id] = 1;
    if (d.shape === 'cross') f |= F_CROSS;
    else f |= F_CUBE;
    if (d.opaque) f |= F_OPAQUE | F_AO;
    if (d.cutout && d.shape !== 'cross') f |= F_AO; // leaves darken their neighbours a little too
    if (d.liquid) f |= F_LIQUID | F_TRANSP | F_CULLSAME;
    else if (d.transparent) f |= F_TRANSP | F_CULLSAME;
    if (d.emissive && !(f & F_TRANSP)) f |= F_EMISSIVE;
    flags[id] = f;
    if (d.key === 'GRASS') tint[id] = T_GRASS;
    else if (d.key === 'LEAVES' || d.key === 'PALM_LEAVES') tint[id] = T_FOLIAGE;
    else if (d.shape === 'cross') tint[id] = d.key === 'TALL_GRASS' ? T_GRASS : T_PLANT;
    else if (JITTER.has(d.key)) tint[id] = T_JITTER;
    if (ROTATE.has(d.key)) rot[id] = 1;
    const ls = LIGHT_SOURCES[d.key];
    if (ls) {
      lightR[id] = ls.R;
      lightCol[id * 3] = ls.color[0] * ls.k; lightCol[id * 3 + 1] = ls.color[1] * ls.k; lightCol[id * 3 + 2] = ls.color[2] * ls.k;
    }
    for (let face = 0; face < 6; face++) {
      const name = d.tex[FACE_SLOT[face]];
      const n = atlas && atlas.variantCount ? Math.min(MAX_VARIANTS, atlas.variantCount(name)) : 1;
      nvar[id * 6 + face] = n;
      for (let v = 0; v < n; v++) {
        const r = atlas && atlas.uvFor ? atlas.uvFor(name, v) : { u0: 0, v0: 0, u1: 0, v1: 0 };
        const o = ((id * 6 + face) * MAX_VARIANTS + v) * 4;
        uv[o] = r.u0; uv[o + 1] = r.v0; uv[o + 2] = r.u1; uv[o + 3] = r.v1;
      }
    }
  }
  return { flags, tint, rot, uv, nvar, solid, lightR, lightCol };
}

/**
 * Copy the 18x(y1-y0+2)x18 neighbourhood of chunk (cx,cz) into pad for chunk-local rows y0-1 .. y1 (inclusive).
 * getData(cx, cz) -> Uint8Array(16*16*96) | null (null = outside the world: treated as air).
 * Rows below y=0 are filled with bedrock (opaque), rows >= 96 with air.
 */
export function fillPad(pad, getData, cx, cz, y0 = 0, y1 = CH) {
  const ya = Math.max(-1, y0 - 1), yb = Math.min(CH, y1);
  const datas = new Array(9);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) datas[(dz + 1) * 3 + dx + 1] = getData(cx + dx, cz + dz);
  const centre = datas[4];
  for (let y = ya; y <= yb; y++) {
    const rowBase = (y + 1) * PAD_LAYER;
    if (y < 0 || y >= CH) {
      pad.fill(y < 0 ? 1 : 0, rowBase, rowBase + PAD_LAYER);
      continue;
    }
    const dy = y * 256;
    for (let z = -1; z <= 16; z++) {
      const zc = z < 0 ? 0 : z > 15 ? 2 : 1;
      const lz = (z + 16) & 15;
      const o = rowBase + (z + 1) * PAD_X;
      // centre span x 0..15
      const dm = datas[zc * 3 + 1];
      if (dm) pad.set(dm.subarray(dy + lz * 16, dy + lz * 16 + 16), o + 1);
      else pad.fill(0, o + 1, o + 17);
      const dl = datas[zc * 3], dr = datas[zc * 3 + 2];
      pad[o] = dl ? dl[dy + lz * 16 + 15] : 0;
      pad[o + 17] = dr ? dr[dy + lz * 16] : 0;
    }
  }
  return centre;
}

// ------------------------------------------------------------------------------------------------ buffers

class QuadBuf {
  constructor(cap = 2048) { this._alloc(cap); this.reset(); }
  _alloc(cap) {
    const old = this.cap ? this : null;
    this.cap = cap;
    const pos = new Float32Array(cap * 12), nor = new Int8Array(cap * 16), col = new Uint8Array(cap * 16);
    const uv = new Float32Array(cap * 8), flip = new Uint8Array(cap), lit = new Uint8Array(cap * 16);
    if (old && this.quads) {
      pos.set(this.pos.subarray(0, this.quads * 12)); nor.set(this.nor.subarray(0, this.quads * 16));
      col.set(this.col.subarray(0, this.quads * 16)); uv.set(this.uv.subarray(0, this.quads * 8)); flip.set(this.flip.subarray(0, this.quads));
      lit.set(this.lit.subarray(0, this.quads * 16));
    }
    this.pos = pos; this.nor = nor; this.col = col; this.uv = uv; this.flip = flip; this.lit = lit;
  }
  reset() { this.quads = 0; this.minY = 1e9; this.maxY = -1e9; }
  grow() { this._alloc(this.cap * 2); }
  /** Compact copy of the content, or null when empty. */
  extract() {
    const q = this.quads;
    if (q === 0) return null;
    return {
      quads: q,
      pos: this.pos.slice(0, q * 12), nor: this.nor.slice(0, q * 16), col: this.col.slice(0, q * 16),
      uv: this.uv.slice(0, q * 8), flip: this.flip.slice(0, q), lit: this.lit.slice(0, q * 16),
      minY: this.minY, maxY: this.maxY,
    };
  }
}

const SCRATCH = { opaque: new QuadBuf(8192), transparent: new QuadBuf(1024), emissive: new QuadBuf(1024) };

// ------------------------------------------------------------------------------------------------ hashes / tints

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return (h ^ (h >>> 16)) >>> 0;
}
function hash2f(x, z) { return (hash3(x, 7919, z) & 0xffff) / 65535; }

/** Smooth value noise at ~28-block scale used for grass/foliage colour patches. [0,1] */
export function biomeNoise(wx, wz) {
  const S = 1 / 28;
  const fx = wx * S, fz = wz * S;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  let tx = fx - x0, tz = fz - z0;
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz);
  const a = hash2f(x0, z0), b = hash2f(x0 + 1, z0), c = hash2f(x0, z0 + 1), d = hash2f(x0 + 1, z0 + 1);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

// linear-space colour multipliers: lush (t=0) .. dry (t=1)
const GRASS_LUSH = [0.78, 1.0, 0.74], GRASS_DRY = [1.0, 0.9, 0.52];
const FOL_LUSH = [0.85, 1.0, 0.85], FOL_DRY = [1.0, 0.92, 0.66];
const _tint = [1, 1, 1];
function tintAt(kind, wx, wz, out) {
  const n = biomeNoise(wx, wz);
  const t = n * n * (3 - 2 * n);
  const A = kind === T_GRASS ? GRASS_LUSH : FOL_LUSH, B = kind === T_GRASS ? GRASS_DRY : FOL_DRY;
  out[0] = A[0] + (B[0] - A[0]) * t; out[1] = A[1] + (B[1] - A[1]) * t; out[2] = A[2] + (B[2] - A[2]) * t;
  return out;
}

// ------------------------------------------------------------------------------------------------ environment

/**
 * Block light sources (night pools of light on nearby surfaces): block key -> radius R (blocks), linear colour, strength.
 * Lit windows are not sources (towers have thousands of them); they glow on their own.
 */
export const LIGHT_SOURCES = {
  LAMP: { R: 10.5, color: [1.0, 0.74, 0.44], k: 1.0 },
  NEON_PINK: { R: 6, color: [1.0, 0.22, 0.66], k: 0.85 },
  NEON_BLUE: { R: 6, color: [0.2, 0.72, 1.0], k: 0.85 },
};
export const MAX_LIGHTS = 256;
/** Lights are binned per 4x4x4 block region of a section so each vertex only tests the lights that can reach it. */
const BIN = 4, BINS = (CS / BIN) * (CS / BIN) * (SECTION_H / BIN), BIN_CAP = 24;
/** Sky exposure kernel: a cell's exposure = fraction of open-sky columns in a (2K+1)^2 neighbourhood at its height. */
export const SKY_K = 2;
const KW = SKY_K * 2 + 1;
const KN = KW * KW;
const HP = CS + 2 + SKY_K * 2;   // 22: heights for columns -3..18
/** Sky exposure is stored as 0..254 in the light attribute's alpha; 255 flags an emissive face (night glow). */
export const SKY_MAX = 254;
/** Covered-area brightness used for the quad-diagonal decision (the shader uses the same default). */
export const COVERED_LIGHT = 0.42;

/** Per-chunk meshing environment (heightmap neighbourhood + light sources). Reusable. */
const _clusters = new Map();

export function createEnv() {
  return { sorted: new Uint8Array(PAD_LAYER * KN), h: new Uint8Array(HP * HP), lights: new Float32Array(MAX_LIGHTS * 8), nLights: 0 };
}

/**
 * Fill `env` for chunk (cx,cz).
 *   getHeights(cx,cz) -> Uint8Array(256) | null   per column: 1 + y of the highest opaque block (0 = open column)
 *   getLights(cx,cz)  -> Array<[lx, y, lz, id]> | null   light-source blocks of that chunk (chunk-local)
 */
export function prepareEnv(env, getHeights, getLights, cx, cz, T) {
  const hs = new Array(9);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) hs[(dz + 1) * 3 + dx + 1] = getHeights(cx + dx, cz + dz);
  const h = env.h;
  for (let z = -1 - SKY_K; z < CS + 1 + SKY_K; z++) {
    const zc = z < 0 ? 0 : z > 15 ? 2 : 1;
    for (let x = -1 - SKY_K; x < CS + 1 + SKY_K; x++) {
      const xc = x < 0 ? 0 : x > 15 ? 2 : 1;
      const src = hs[zc * 3 + xc];
      h[(x + 1 + SKY_K) + (z + 1 + SKY_K) * HP] = src ? src[(x & 15) | ((z & 15) << 4)] : 0;
    }
  }
  const sorted = env.sorted;
  for (let z = 0; z < PAD_X; z++) {
    for (let x = 0; x < PAD_X; x++) {
      const base = (x + z * PAD_X) * KN;
      let n = 0;
      for (let kz = 0; kz < KW; kz++) {
        for (let kx = 0; kx < KW; kx++) {
          const v = h[(x + kx) + (z + kz) * HP];
          let j = n++;
          while (j > 0 && sorted[base + j - 1] > v) { sorted[base + j] = sorted[base + j - 1]; j--; }
          sorted[base + j] = v;
        }
      }
    }
  }
  // collect sources, clustering same-type blocks within 3x3x3 cells (a neon sign's tube row acts as one light)
  let nl = 0;
  const L = env.lights;
  const cl = _clusters;
  cl.clear();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const list = getLights ? getLights(cx + dx, cz + dz) : null;
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        const id = e[3];
        const R = T.lightR[id];
        if (!R) continue;
        const px = e[0] + dx * CS + 0.5, py = e[1] + 0.5, pz = e[2] + dz * CS + 0.5;
        if (px < -R || px > CS + R || pz < -R || pz > CS + R) continue;
        const key = id * 1e6 + Math.floor((px + 16) / 3) * 1e4 + Math.floor(py / 3) * 100 + Math.floor((pz + 16) / 3);
        let o = cl.get(key);
        if (o === undefined) {
          if (nl >= MAX_LIGHTS) continue;
          o = nl * 8; cl.set(key, o); nl++;
          L[o] = 0; L[o + 1] = 0; L[o + 2] = 0; L[o + 3] = R; L[o + 4] = id; L[o + 7] = 0;
        }
        L[o] += px; L[o + 1] += py; L[o + 2] += pz; L[o + 7]++;
      }
    }
  }
  for (let k = 0; k < nl; k++) {
    const o = k * 8, n = L[o + 7], id = L[o + 4];
    L[o] /= n; L[o + 1] /= n; L[o + 2] /= n;
    const gain = 1 + 0.55 * (n - 1);
    L[o + 3] = T.lightR[id] * (1 + 0.06 * (n - 1));
    L[o + 4] = T.lightCol[id * 3] * gain; L[o + 5] = T.lightCol[id * 3 + 1] * gain; L[o + 6] = T.lightCol[id * 3 + 2] * gain;
  }
  env.nLights = nl;
  return env;
}

// ------------------------------------------------------------------------------------------------ meshing

const _ao = new Uint8Array(4);
const _sky = new Float32Array(4);
const EXPO = new Uint8Array(PAD_LAYER * (SECTION_H + 2));
const SEC_LIGHTS = new Float32Array(MAX_LIGHTS * 8);
const BIN_N = new Uint8Array(BINS);
const BIN_L = new Uint16Array(BINS * BIN_CAP);
let secLightCount = 0;
let binIndex = 0;
// per-section cache of block light at integer corners, per face direction (corners are shared by up to 4 faces)
const CC = CS + 1, CCY = SECTION_H + 1;
const CORNER_LIGHT = new Float32Array(CC * CC * CCY * 6 * 3);
const CORNER_STAMP = new Uint32Array(CC * CC * CCY * 6);
let stamp = 1;
let secY0 = 0;
let useSky = false;

/**
 * Mesh one section (s = 0..SECTIONS-1) of the chunk whose neighbourhood is in `pad`.
 * wx0/wz0 = world coords of the chunk origin (hashes / tints). env (optional, see prepareEnv) adds sky exposure and
 * block light. Returns { opaque, transparent, emissive, faces }.
 */
export function meshSection(pad, s, T, wx0 = 0, wz0 = 0, env = null) {
  const flags = T.flags;
  const bo = SCRATCH.opaque, bt = SCRATCH.transparent, be = SCRATCH.emissive;
  bo.reset(); bt.reset(); be.reset();
  let faces = 0;
  const y0 = s * SECTION_H, y1 = y0 + SECTION_H;
  secY0 = y0;
  useSky = !!env;
  secLightCount = 0;
  if (env) {
    const sorted = env.sorted;
    for (let col = 0; col < PAD_LAYER; col++) {
      const base = col * KN;
      let p = 0;
      for (let yy = 0; yy < SECTION_H + 2; yy++) {
        const y = y0 - 1 + yy;
        while (p < KN && sorted[base + p] <= y) p++;
        EXPO[col + yy * PAD_LAYER] = p;
      }
    }
    const L = env.lights;
    for (let k = 0; k < env.nLights; k++) {
      const o = k * 8, R = L[o + 3];
      if (L[o + 1] < y0 - R || L[o + 1] > y1 + R) continue;
      SEC_LIGHTS.set(L.subarray(o, o + 8), secLightCount * 8);
      secLightCount++;
    }
    if (secLightCount) {
      stamp = (stamp + 1) >>> 0;
      if (stamp === 0) { CORNER_STAMP.fill(0); stamp = 1; }
      // bin: box of each 4x4x4 region grown by 1 block (vertices sit on block corners) vs light sphere
      BIN_N.fill(0);
      for (let k = 0; k < secLightCount; k++) {
        const o = k * 8, lx = SEC_LIGHTS[o], ly = SEC_LIGHTS[o + 1] - y0, lz = SEC_LIGHTS[o + 2], R = SEC_LIGHTS[o + 3], R2 = R * R;
        for (let by = 0; by < SECTION_H / BIN; by++) {
          const ay = by * BIN - 1, byy = by * BIN + BIN + 1;
          const dy = ly < ay ? ay - ly : ly > byy ? ly - byy : 0;
          if (dy * dy >= R2) continue;
          for (let bz = 0; bz < CS / BIN; bz++) {
            const az = bz * BIN - 1, bzz = bz * BIN + BIN + 1;
            const dz = lz < az ? az - lz : lz > bzz ? lz - bzz : 0;
            if (dy * dy + dz * dz >= R2) continue;
            for (let bx = 0; bx < CS / BIN; bx++) {
              const ax = bx * BIN - 1, bxx = bx * BIN + BIN + 1;
              const dx = lx < ax ? ax - lx : lx > bxx ? lx - bxx : 0;
              if (dx * dx + dy * dy + dz * dz >= R2) continue;
              const b = bx + bz * 4 + by * 16;
              if (BIN_N[b] < BIN_CAP) BIN_L[b * BIN_CAP + BIN_N[b]++] = k;
            }
          }
        }
      }
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let z = 0; z < CS; z++) {
      let i = 1 + (z + 1) * PAD_X + (y + 1) * PAD_LAYER;
      for (let x = 0; x < CS; x++, i++) {
        const id = pad[i];
        if (id === 0) continue;
        const f = flags[id];
        if (f & F_CROSS) { emitCross(bo, T, i, id, x, y, z, wx0, wz0); faces += 4; continue; }
        if ((f & F_CUBE) === 0) continue;
        // emissive faces share the opaque mesh (flagged through the light attribute: alpha 255), saving a draw call
        const buf = (f & F_TRANSP) ? bt : bo;
        let topH = 1;
        if (f & F_LIQUID) {
          const up = flags[pad[i + PAD_LAYER]];
          if ((up & (F_LIQUID | F_OPAQUE)) === 0) topH = WATER_TOP;
        }
        for (let face = 0; face < 6; face++) {
          const nid = pad[i + NOFF[face]];
          if (nid !== 0) {
            const nf = flags[nid];
            if (nf & F_OPAQUE) continue;
            if (nid === id && (f & F_CULLSAME)) continue;
          }
          emitFace(buf, pad, T, i, id, f, face, x, y, z, topH, wx0, wz0, false);
          faces++;
          if (face === 2 && topH < 1) { emitFace(buf, pad, T, i, id, f, face, x, y, z, topH, wx0, wz0, true); faces++; }
        }
      }
    }
  }
  return { opaque: bo.extract(), transparent: bt.extract(), emissive: be.extract(), faces };
}

/** Sky exposure (0..1) of a padded cell, averaged like smooth lighting: opaque samples are skipped. */
function cellSky(pad, flags, idx) { return EXPO[idx - secY0 * PAD_LAYER] / KN; }

/** Block light at a vertex (chunk-local position, unit normal) into out[0..2] (0..1+). */
const _bl = [0, 0, 0];
function blockLightAt(px, py, pz, nx, ny, nz, out) {
  let r = 0, g = 0, b = 0;
  const n = BIN_N[binIndex], base = binIndex * BIN_CAP;
  for (let j = 0; j < n; j++) {
    const o = BIN_L[base + j] * 8;
    const dx = SEC_LIGHTS[o] - px, dy = SEC_LIGHTS[o + 1] - py, dz = SEC_LIGHTS[o + 2] - pz, R = SEC_LIGHTS[o + 3];
    const d2 = dx * dx + dy * dy + dz * dz;
    const R2 = R * R;
    if (d2 >= R2) continue;
    let f = 1 - d2 / R2; f *= f;
    let w = 1;
    if (d2 > 0.36) {
      const ndl = (dx * nx + dy * ny + dz * nz) / Math.sqrt(d2);
      w = ndl >= 0 ? 0.35 + 0.65 * ndl : (ndl > -0.35 ? 0.35 + ndl : 0);
    }
    f *= w;
    r += SEC_LIGHTS[o + 4] * f; g += SEC_LIGHTS[o + 5] * f; b += SEC_LIGHTS[o + 6] * f;
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

function emitFace(buf, pad, T, i, id, f, face, x, y, z, topH, wx0, wz0, underside) {
  if (buf.quads >= buf.cap) buf.grow();
  const q = buf.quads++;
  const flags = T.flags;
  const emissive = (f & F_EMISSIVE) !== 0;
  const ni = i + NOFF[face];
  // ambient occlusion + sky exposure per corner
  const ao = _ao, sky = _sky;
  for (let c = 0; c < 4; c++) {
    const o = (face * 4 + c) * 3;
    const a1 = ni + AOFF[o], a2 = ni + AOFF[o + 1], a3 = ni + AOFF[o + 2];
    const f1 = flags[pad[a1]], f2 = flags[pad[a2]], f3 = flags[pad[a3]];
    const s1 = (f1 & F_AO) ? 1 : 0, s2 = (f2 & F_AO) ? 1 : 0, cr = (f3 & F_AO) ? 1 : 0;
    ao[c] = emissive ? 3 : (s1 && s2) ? 0 : 3 - (s1 + s2 + cr);
    if (useSky) {
      let sum = cellSky(pad, flags, ni), n = 1;
      if (!(f1 & F_OPAQUE)) { sum += cellSky(pad, flags, a1); n++; }
      if (!(f2 & F_OPAQUE)) { sum += cellSky(pad, flags, a2); n++; }
      if (!(f3 & F_OPAQUE) && !((f1 & F_OPAQUE) && (f2 & F_OPAQUE))) { sum += cellSky(pad, flags, a3); n++; }
      sky[c] = sum / n;
    } else sky[c] = 1;
  }
  // quad diagonal follows the darker corners (no anisotropy artefacts)
  let flip = 0;
  {
    const b0 = AO_CURVE[ao[0]] * (COVERED_LIGHT + (1 - COVERED_LIGHT) * sky[0]);
    const b1 = AO_CURVE[ao[1]] * (COVERED_LIGHT + (1 - COVERED_LIGHT) * sky[1]);
    const b2 = AO_CURVE[ao[2]] * (COVERED_LIGHT + (1 - COVERED_LIGHT) * sky[2]);
    const b3 = AO_CURVE[ao[3]] * (COVERED_LIGHT + (1 - COVERED_LIGHT) * sky[3]);
    if (b0 + b2 > b1 + b3 + 1e-4) flip = 1;
  }
  buf.flip[q] = flip;
  // positions
  const pos = buf.pos, po = q * 12;
  const cf = face * 12;
  const wx = wx0 + x, wz = wz0 + z;
  for (let c = 0; c < 4; c++) {
    const k = underside ? 3 - c : c; // reversed winding for the water surface seen from below
    pos[po + c * 3] = x + FACE_CF[cf + k * 3];
    pos[po + c * 3 + 1] = y + (FACE_CF[cf + k * 3 + 1] ? topH : 0);
    pos[po + c * 3 + 2] = z + FACE_CF[cf + k * 3 + 2];
  }
  if (pos[po + 1] < buf.minY) buf.minY = pos[po + 1];
  const top = y + (face === 3 ? 0 : topH);
  if (top > buf.maxY) buf.maxY = top;
  // normals
  const nor = buf.nor, no = q * 16;
  const nx = FACE_NI[face * 3], ny = underside ? -127 : FACE_NI[face * 3 + 1], nz = FACE_NI[face * 3 + 2];
  for (let c = 0; c < 4; c++) { nor[no + c * 4] = nx; nor[no + c * 4 + 1] = ny; nor[no + c * 4 + 2] = nz; nor[no + c * 4 + 3] = 0; }
  // uvs (variant + optional random rotation of top/bottom faces)
  const h = hash3(wx, y, wz);
  const nv = T.nvar[id * 6 + face];
  const v = nv > 1 ? (h % nv) : 0;
  const uo = ((id * 6 + face) * MAX_VARIANTS + v) * 4;
  const u0 = T.uv[uo], v0 = T.uv[uo + 1], u1 = T.uv[uo + 2], v1 = T.uv[uo + 3];
  const vt = (face !== 2 && face !== 3 && topH < 1) ? v0 + (v1 - v0) * topH : v1;
  const rot = (T.rot[id] && (face === 2 || face === 3)) ? (h >>> 8) & 3 : 0;
  const uvs = buf.uv, uvo = q * 8;
  for (let c = 0; c < 4; c++) {
    const k = ((underside ? 3 - c : c) + rot) & 3;
    uvs[uvo + c * 2] = (k === 0 || k === 3) ? u0 : u1;
    uvs[uvo + c * 2 + 1] = (k === 0 || k === 1) ? v0 : vt;
  }
  // colours: shade * AO * tint; light attribute: block light rgb + sky exposure
  const col = buf.col, co = q * 16, lit = buf.lit;
  const tk = T.tint[id];
  let jr = 1, jg = 1, jb = 1;
  if (tk === T_JITTER) { const j = 1 - ((h >>> 12) & 255) / 255 * 0.07; jr = jg = jb = j; }
  const fnx = nx / 127, fny = ny / 127, fnz = nz / 127;
  const useLights = secLightCount > 0 && (binIndex = (x >> 2) + (z >> 2) * 4 + ((y - secY0) >> 2) * 16, BIN_N[binIndex] > 0);
  for (let c = 0; c < 4; c++) {
    let L = emissive ? LIGHT_EMI[face] : LIGHT[face * 4 + ao[c]];
    if (underside) L = LIGHT[3 * 4 + 3] * 1.2;
    let r = jr, g = jg, b = jb;
    const k = underside ? 3 - c : c;
    if ((tk === T_GRASS && face === 2) || tk === T_FOLIAGE) {
      tintAt(tk, wx + FACE_CF[cf + k * 3], wz + FACE_CF[cf + k * 3 + 2], _tint);
      r = _tint[0]; g = _tint[1]; b = _tint[2];
    }
    col[co + c * 4] = Math.min(255, L * r);
    col[co + c * 4 + 1] = Math.min(255, L * g);
    col[co + c * 4 + 2] = Math.min(255, L * b);
    col[co + c * 4 + 3] = 255;
    if (useLights) {
      const px = pos[po + c * 3], py = pos[po + c * 3 + 1], pz = pos[po + c * 3 + 2];
      const ly = py - secY0;
      if (!underside && topH === 1 && ly >= 0 && ly <= SECTION_H) {
        const ci = ((px + (pz + ly * CC) * CC) * 6 + face);
        if (CORNER_STAMP[ci] !== stamp) {
          blockLightAt(px, py, pz, fnx, fny, fnz, _bl);
          CORNER_STAMP[ci] = stamp;
          CORNER_LIGHT[ci * 3] = _bl[0]; CORNER_LIGHT[ci * 3 + 1] = _bl[1]; CORNER_LIGHT[ci * 3 + 2] = _bl[2];
        }
        lit[co + c * 4] = Math.min(255, CORNER_LIGHT[ci * 3] * 255);
        lit[co + c * 4 + 1] = Math.min(255, CORNER_LIGHT[ci * 3 + 1] * 255);
        lit[co + c * 4 + 2] = Math.min(255, CORNER_LIGHT[ci * 3 + 2] * 255);
      } else {
        blockLightAt(px, py, pz, fnx, fny, fnz, _bl);
        lit[co + c * 4] = Math.min(255, _bl[0] * 255);
        lit[co + c * 4 + 1] = Math.min(255, _bl[1] * 255);
        lit[co + c * 4 + 2] = Math.min(255, _bl[2] * 255);
      }
    } else { lit[co + c * 4] = 0; lit[co + c * 4 + 1] = 0; lit[co + c * 4 + 2] = 0; }
    lit[co + c * 4 + 3] = emissive ? 255 : Math.round(sky[underside ? 3 - c : c] * SKY_MAX);
  }
}

const CROSS_D = 0.5 - 0.5 / Math.SQRT2; // quad width = 1 block
const CROSS_Q = [
  [CROSS_D, CROSS_D, 1 - CROSS_D, 1 - CROSS_D],
  [1 - CROSS_D, CROSS_D, CROSS_D, 1 - CROSS_D],
];

function emitCross(buf, T, i, id, x, y, z, wx0, wz0) {
  const wx = wx0 + x, wz = wz0 + z;
  const h = hash3(wx, y, wz);
  // small random offset so plants don't line up on the grid
  const ox = (((h >>> 4) & 15) / 15 - 0.5) * 0.3, oz = (((h >>> 8) & 15) / 15 - 0.5) * 0.3;
  const uo = (id * 6) * MAX_VARIANTS * 4;
  const u0 = T.uv[uo], v0 = T.uv[uo + 1], u1 = T.uv[uo + 2], v1 = T.uv[uo + 3];
  const tk = T.tint[id];
  let r = 1, g = 1, b = 1;
  if (tk === T_GRASS) { tintAt(T_GRASS, wx + 0.5, wz + 0.5, _tint); r = _tint[0]; g = _tint[1]; b = _tint[2]; }
  const lt = 255, lb = 255 * 0.62;
  const skyA = useSky ? Math.round((EXPO[i - secY0 * PAD_LAYER] / KN) * SKY_MAX) : SKY_MAX;
  let lr = 0, lg = 0, lbl = 0;
  if (secLightCount) {
    binIndex = (x >> 2) + (z >> 2) * 4 + ((y - secY0) >> 2) * 16;
    if (BIN_N[binIndex]) {
      blockLightAt(x + 0.5, y + 0.6, z + 0.5, 0, 1, 0, _bl);
      lr = Math.min(255, _bl[0] * 255); lg = Math.min(255, _bl[1] * 255); lbl = Math.min(255, _bl[2] * 255);
    }
  }
  for (let d = 0; d < 2; d++) {
    const [ax, az, bx, bz] = CROSS_Q[d];
    for (let side = 0; side < 2; side++) {
      if (buf.quads >= buf.cap) buf.grow();
      const q = buf.quads++;
      buf.flip[q] = 0;
      const p0x = side ? bx : ax, p0z = side ? bz : az, p1x = side ? ax : bx, p1z = side ? az : bz;
      const pos = buf.pos, po = q * 12;
      pos[po] = x + p0x + ox; pos[po + 1] = y; pos[po + 2] = z + p0z + oz;
      pos[po + 3] = x + p1x + ox; pos[po + 4] = y; pos[po + 5] = z + p1z + oz;
      pos[po + 6] = x + p1x + ox; pos[po + 7] = y + 1; pos[po + 8] = z + p1z + oz;
      pos[po + 9] = x + p0x + ox; pos[po + 10] = y + 1; pos[po + 11] = z + p0z + oz;
      if (y < buf.minY) buf.minY = y;
      if (y + 1 > buf.maxY) buf.maxY = y + 1;
      const nor = buf.nor, no = q * 16;
      for (let c = 0; c < 4; c++) { nor[no + c * 4] = 0; nor[no + c * 4 + 1] = 127; nor[no + c * 4 + 2] = 0; nor[no + c * 4 + 3] = 0; }
      const uvs = buf.uv, uvo = q * 8;
      uvs[uvo] = u0; uvs[uvo + 1] = v0; uvs[uvo + 2] = u1; uvs[uvo + 3] = v0;
      uvs[uvo + 4] = u1; uvs[uvo + 5] = v1; uvs[uvo + 6] = u0; uvs[uvo + 7] = v1;
      const col = buf.col, co = q * 16, lit = buf.lit;
      for (let c = 0; c < 4; c++) {
        const L = c < 2 ? lb : lt;
        col[co + c * 4] = Math.min(255, L * r); col[co + c * 4 + 1] = Math.min(255, L * g);
        col[co + c * 4 + 2] = Math.min(255, L * b); col[co + c * 4 + 3] = 255;
        lit[co + c * 4] = lr; lit[co + c * 4 + 1] = lg; lit[co + c * 4 + 2] = lbl; lit[co + c * 4 + 3] = skyA;
      }
    }
  }
}

/**
 * Concatenate section parts of one pass into indexed geometry arrays.
 * Returns null when there is nothing to draw. Index type is Uint16 when possible, else Uint32.
 */
export function mergeParts(parts) {
  let quads = 0, minY = 1e9, maxY = -1e9;
  for (const p of parts) {
    if (!p) continue;
    quads += p.quads;
    if (p.minY < minY) minY = p.minY;
    if (p.maxY > maxY) maxY = p.maxY;
  }
  if (quads === 0) return null;
  const vc = quads * 4;
  const position = new Float32Array(vc * 3), normal = new Int8Array(vc * 4), color = new Uint8Array(vc * 4), uv = new Float32Array(vc * 2);
  const light = new Uint8Array(vc * 4);
  const index = vc > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let q0 = 0;
  for (const p of parts) {
    if (!p) continue;
    position.set(p.pos, q0 * 12); normal.set(p.nor, q0 * 16); color.set(p.col, q0 * 16); uv.set(p.uv, q0 * 8);
    light.set(p.lit, q0 * 16);
    const fl = p.flip;
    for (let k = 0; k < p.quads; k++) {
      const b = (q0 + k) * 4, io = (q0 + k) * 6;
      if (fl[k]) {
        index[io] = b + 1; index[io + 1] = b + 2; index[io + 2] = b + 3;
        index[io + 3] = b + 1; index[io + 4] = b + 3; index[io + 5] = b;
      } else {
        index[io] = b; index[io + 1] = b + 1; index[io + 2] = b + 2;
        index[io + 3] = b; index[io + 4] = b + 2; index[io + 5] = b + 3;
      }
    }
    q0 += p.quads;
  }
  return { position, normal, color, uv, light, index, vertexCount: vc, quads, minY, maxY };
}
