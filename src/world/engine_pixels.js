// Pixel-art toolkit used by the procedural texture atlas (WORLD-ENGINE).
// Pure JS (no DOM): tiles are RGBA Uint8ClampedArrays, so the whole atlas can be generated and unit-tested in node.
//
//   PixelTile        16x16 (or any size) RGBA image with wrap-around addressing (textures tile seamlessly)
//   tileNoise(rng,n) seamless value noise with n cells per tile (period = tile size)
//   rgb / mix / mul  colour helpers (colours are [r,g,b] arrays of 0..255 floats)
//   buildCellMips    gutter-padded per-tile mip chain in linear light (coverage-preserving for cutout tiles)
//   downsample       generic 2x2 box filter (linear light, alpha weighted)

export const TS = 16;

/** 0xRRGGBB -> [r, g, b] */
export function rgb(hex) { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]; }
/** [r, g, b] -> 0xRRGGBB */
export function toHex(c) {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return (r << 16) | (g << 8) | b;
}
export function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
export function mul(c, f) { return [c[0] * f, c[1] * f, c[2] * f]; }
export function add(c, d) { return [c[0] + d, c[1] + d, c[2] + d]; }
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (t) => t * t * (3 - 2 * t);

/** Pick from a palette with v in [0,1). */
export function pick(pal, v) {
  const i = Math.floor(v * pal.length);
  return pal[i < 0 ? 0 : i >= pal.length ? pal.length - 1 : i];
}

/** Small deterministic string hash (FNV-1a) used to seed per-texture RNGs. */
export function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** mulberry32 RNG -> [0,1) with helpers. */
export function rngFrom(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * r());
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.chance = (p) => r() < p;
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

export class PixelTile {
  constructor(w = TS, h = TS) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  idx(x, y) {
    const w = this.w, h = this.h;
    x = Math.floor(x) % w; if (x < 0) x += w;
    y = Math.floor(y) % h; if (y < 0) y += h;
    return (y * w + x) * 4;
  }

  /** Set pixel (wraps around). c = [r,g,b]. */
  set(x, y, c, a = 255) {
    const i = this.idx(x, y), d = this.data;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }

  get(x, y) {
    const i = this.idx(x, y), d = this.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  rgbAt(x, y) {
    const i = this.idx(x, y), d = this.data;
    return [d[i], d[i + 1], d[i + 2]];
  }

  alpha(x, y) { return this.data[this.idx(x, y) + 3]; }
  setAlpha(x, y, a) { this.data[this.idx(x, y) + 3] = a; }

  /** Multiply the colour of a pixel. */
  shade(x, y, f) {
    const i = this.idx(x, y), d = this.data;
    d[i] = d[i] * f; d[i + 1] = d[i + 1] * f; d[i + 2] = d[i + 2] * f;
  }

  /** Alpha-composite colour c with opacity a (0..1) over the pixel. */
  blend(x, y, c, a) {
    const i = this.idx(x, y), d = this.data;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[i] = (c[0] * a + d[i] * da * (1 - a)) / oa;
    d[i + 1] = (c[1] * a + d[i + 1] * da * (1 - a)) / oa;
    d[i + 2] = (c[2] * a + d[i + 2] * da * (1 - a)) / oa;
    d[i + 3] = oa * 255;
  }

  fill(c, a = 255) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c, a);
  }

  /** Per-pixel callback fn(x, y) -> [r,g,b] or [r,g,b,a]. */
  paint(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = fn(x, y);
        if (c) this.set(x, y, c, c.length > 3 ? c[3] : 255);
      }
    }
  }

  copyFrom(other) { this.data.set(other.data); return this; }

  clone() { const t = new PixelTile(this.w, this.h); t.data.set(this.data); return t; }

  /** Fraction of pixels with alpha >= 128. */
  coverage() {
    let n = 0;
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] >= 128) n++;
    return n / (this.w * this.h);
  }

  /** Average colour of the visible pixels (alpha weighted, sRGB bytes). */
  average() {
    let r = 0, g = 0, b = 0, w = 0;
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      r += d[i] * a; g += d[i + 1] * a; b += d[i + 2] * a; w += a;
    }
    if (w <= 0) return [0, 0, 0];
    return [r / w, g / w, b / w];
  }
}

/** Seamless (period = tile size) smooth value noise. Returns fn(x, y) -> [0,1] for pixel coords. */
export function tileNoise(rng, cells, size = TS) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const m = (v) => ((v % cells) + cells) % cells;
  return (x, y) => {
    const fx = ((x + 0.5) / size) * cells, fy = ((y + 0.5) / size) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const sx = smooth(fx - x0), sy = smooth(fy - y0);
    const a = g[m(x0) + m(y0) * cells], b = g[m(x0 + 1) + m(y0) * cells];
    const c = g[m(x0) + m(y0 + 1) * cells], d = g[m(x0 + 1) + m(y0 + 1) * cells];
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };
}

// ------------------------------------------------------------------------------------------------ colour space

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const L2S = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const v = i / 4096;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  L2S[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}
export const srgbToLinear = (b) => S2L[b];
export const linearToSrgb = (v) => L2S[Math.max(0, Math.min(4096, Math.round(v * 4096)))];

/**
 * 2x2 box filter of an RGBA image (sRGB bytes) in linear light with alpha-weighted colour.
 * Returns { data, width, height } of half size (min 1).
 */
export function downsample(src, sw, sh) {
  const dw = Math.max(1, sw >> 1), dh = Math.max(1, sh >> 1);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let oy = 0; oy < 2; oy++) {
        const sy = Math.min(sh - 1, y * 2 + oy);
        for (let ox = 0; ox < 2; ox++) {
          const sx = Math.min(sw - 1, x * 2 + ox);
          const i = (sy * sw + sx) * 4;
          const al = src[i + 3] / 255;
          r += S2L[src[i]] * al; g += S2L[src[i + 1]] * al; b += S2L[src[i + 2]] * al; a += al; n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { out[o] = linearToSrgb(r / a); out[o + 1] = linearToSrgb(g / a); out[o + 2] = linearToSrgb(b / a); }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * Build the gutter-padded mip chain of one tile.
 *   tile    PixelTile 16x16
 *   gutter  pixels of wrap-around padding on each side at level 0 (power of two, e.g. 8 -> 32px cell)
 *   cutout  true for alpha-tested tiles: alpha is re-binarised per level so the coverage stays constant
 *           (leaves don't thin out in the distance)
 * Returns [{data, size}] for cell sizes cell, cell/2, ... 1.
 */
export function buildCellMips(tile, gutter, cutout) {
  const ts = tile.w;
  const cell = ts + gutter * 2;
  const lvl0 = new Uint8ClampedArray(cell * cell * 4);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const si = tile.idx(x - gutter, y - gutter);
      const di = (y * cell + x) * 4;
      lvl0[di] = tile.data[si]; lvl0[di + 1] = tile.data[si + 1]; lvl0[di + 2] = tile.data[si + 2]; lvl0[di + 3] = tile.data[si + 3];
    }
  }
  // Fully transparent pixels take the tile's average colour so filtering never pulls in black fringes.
  const avg = tile.average();
  for (let i = 0; i < lvl0.length; i += 4) {
    if (lvl0[i + 3] === 0) { lvl0[i] = avg[0]; lvl0[i + 1] = avg[1]; lvl0[i + 2] = avg[2]; }
  }
  const levels = [{ data: lvl0, size: cell }];
  const cov = cutout ? tile.coverage() : 1;
  let cur = lvl0, size = cell;
  while (size > 1) {
    const d = downsample(cur, size, size);
    size = d.width;
    if (cutout) binarizeAlpha(d.data, cov);
    // keep the average colour under transparent texels
    for (let i = 0; i < d.data.length; i += 4) {
      if (d.data[i + 3] === 0) { d.data[i] = avg[0]; d.data[i + 1] = avg[1]; d.data[i + 2] = avg[2]; }
    }
    levels.push({ data: d.data, size });
    cur = d.data;
  }
  return levels;
}

/** Re-binarise alpha so that `coverage` (0..1) of texels end opaque (highest alphas first). */
function binarizeAlpha(data, coverage) {
  const n = data.length / 4;
  const k = Math.round(coverage * n);
  if (k >= n) { for (let i = 3; i < data.length; i += 4) data[i] = 255; return; }
  if (k <= 0) { for (let i = 3; i < data.length; i += 4) data[i] = 0; return; }
  const alphas = new Uint8Array(n);
  for (let i = 0; i < n; i++) alphas[i] = data[i * 4 + 3];
  const sorted = Array.from(alphas).sort((a, b) => b - a);
  const th = Math.max(1, sorted[k - 1]);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const on = alphas[i] >= th && opaque < k;
    if (on) opaque++;
    data[i * 4 + 3] = on ? 255 : 0;
  }
}
