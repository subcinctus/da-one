// Procedural 16x16 pixel-art painters for every block texture (WORLD-ENGINE).
// Pure JS (no DOM). Each painter draws into a PixelTile with its own seeded RNG so the atlas is deterministic.
//
//   paintTexture(name, variant = 0, colorHint) -> PixelTile
//   TEXTURE_VARIANTS   name -> number of visual variants (mesher picks one per block position)
//   WATER_FRAMES       number of animation frames of the water tile (paintWaterFrame(f))
//   DESTROY_STAGES     10 mining-crack overlay stages ('destroy_0'..'destroy_9')
import {
  PixelTile, rgb, mix, mul, pick, clamp01, tileNoise, rngFrom, strHash,
} from './engine_pixels.js';

export const TEXTURE_VARIANTS = { window_lit: 4, window_lit_night: 4, window: 2 };
/**
 * Atlas tiles that no block face uses directly; shaders sample them at a fixed cell offset from a block tile:
 * day tile -> night tile (same variant count, laid out right after the block tiles, see textures.js).
 */
export const NIGHT_TILES = { window_lit: 'window_lit_night' };
export const WATER_FRAMES = 8;
export const DESTROY_STAGES = 10;

const pal = (...hexes) => hexes.map(rgb);
/**
 * Emissive tiles encode a per-pixel glow mask in alpha: 255 = glows at night, GLOW_OFF (240) = plain lit surface
 * (window frames, lamp housings, neon backing). The world's emissive material derives the mask from alpha.
 */
export const GLOW_OFF = 240;
const rngFor = (name, v = 0) => rngFrom(strHash(name) ^ Math.imul(v + 1, 0x9e3779b1));
/** Brightness variation that also works for very dark colours (adds a little absolute offset). */
const vary = (c, f) => [c[0] * f + (f - 1) * 40, c[1] * f + (f - 1) * 40, c[2] * f + (f - 1) * 40];

const P = Object.create(null);

// ------------------------------------------------------------------------------------------------ natural

const GRASS = pal(0x447f25, 0x4c8a2a, 0x54952f, 0x5c9f34, 0x64a839, 0x6eb240);

P.grass_top = (t, r) => {
  const n = tileNoise(r, 4), n2 = tileNoise(r, 8);
  t.paint((x, y) => pick(GRASS, clamp01(0.42 * n(x, y) + 0.22 * n2(x, y) + 0.42 * r() - 0.03)));
  for (let k = 0; k < 7; k++) {
    const x = r.int(0, 15), y = r.int(0, 15);
    t.set(x, y, rgb(0x3d7520));
    t.set(x, y - 1, rgb(0x78bc47));
  }
};

function paintDirt(t, r) {
  const p = pal(0x5a3c23, 0x664429, 0x734e2f, 0x7f5835, 0x8a613c);
  const n = tileNoise(r, 4);
  t.paint((x, y) => pick(p, clamp01(0.38 * n(x, y) + 0.62 * r())));
  for (let k = 0; k < 7; k++) {
    const x = r.int(0, 15), y = r.int(0, 15);
    if (r() < 0.55) { t.set(x, y, rgb(0x9b7752)); t.set(x + 1, y + 1, rgb(0x4e341e)); }
    else { t.set(x, y, rgb(0x46301c)); }
  }
}
P.dirt = paintDirt;

P.grass_side = (t, r) => {
  paintDirt(t, rngFor('dirt'));
  for (let x = 0; x < 16; x++) {
    let depth = 3 + (r() < 0.55 ? 1 : 0);
    if (r() < 0.22) depth += 1;
    if (r() < 0.1) depth += 2;
    for (let y = 0; y < depth; y++) {
      const c = pick(GRASS, clamp01(0.25 + 0.6 * r() - y * 0.07));
      t.set(x, y, mul(c, y === depth - 1 ? 0.86 : 1));
    }
    t.shade(x, depth, 0.82);
  }
};

function paintStone(t, r) {
  const p = pal(0x606060, 0x6a6a6a, 0x747474, 0x7e7e7e, 0x888888, 0x929292);
  const n = tileNoise(r, 4), n2 = tileNoise(r, 8);
  t.paint((x, y) => pick(p, clamp01(0.42 * n(x, y) + 0.2 * n2(x, y) + 0.38 * r())));
  for (let k = 0; k < 5; k++) {
    let x = r.int(0, 15), y = r.int(0, 15);
    const len = r.int(2, 5), dx = r() < 0.5 ? -1 : 1;
    for (let s = 0; s < len; s++) {
      t.set(x, y, rgb(0x525252));
      t.blend(x, y - 1, rgb(0xa0a0a0), 0.45);
      x += dx;
      if (r() < 0.45) y += r() < 0.5 ? -1 : 1;
    }
  }
}
P.stone = paintStone;

P.cobblestone = (t, r) => {
  const tones = pal(0x6a6a6a, 0x777777, 0x838383, 0x8f8f8f, 0x9a9a9a);
  const pts = [];
  // jittered grid so stones have similar sizes (rounded, irregular)
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      pts.push([(gx + 0.2 + r() * 0.6) * (16 / 3), (gy + 0.2 + r() * 0.6) * (16 / 3), r.pick(tones)]);
    }
  }
  pts.push([r() * 16, r() * 16, r.pick(tones)]);
  const mortar = pal(0x3f3f3f, 0x4a4a4a, 0x545454);
  t.paint((x, y) => {
    const px = x + 0.5, py = y + 0.5;
    let d1 = 1e9, d2 = 1e9, best = null, bdx = 0, bdy = 0;
    for (const p of pts) {
      for (let oy = -16; oy <= 16; oy += 16) {
        for (let ox = -16; ox <= 16; ox += 16) {
          const dx = px - (p[0] + ox), dy = py - (p[1] + oy);
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) { d2 = d1; d1 = d; best = p; bdx = dx; bdy = dy; } else if (d < d2) d2 = d;
        }
      }
    }
    const gap = d2 - d1;
    if (gap < 1.0) return pick(mortar, r());
    const l = clamp01(0.5 + (-bdx - bdy) / (2 * (d1 + 2)));
    const inner = clamp01((gap - 1.0) / 2.2);
    let c = mul(best[2], 0.82 + 0.3 * l);
    c = mul(c, 0.86 + 0.14 * inner);
    return vary(c, 0.95 + 0.1 * r());
  });
};

function paintOre(t, r, cols, clusters) {
  paintStone(t, rngFor('stone'));
  const [dark, midC, light] = cols.map(rgb);
  for (let c = 0; c < clusters; c++) {
    let x = r.int(1, 13), y = r.int(1, 13);
    const n = r.int(3, 6);
    const cells = new Set();
    for (let k = 0; k < n; k++) {
      cells.add(((x + 16) % 16) + ((y + 16) % 16) * 16);
      if (r() < 0.5) x += r() < 0.5 ? -1 : 1; else y += r() < 0.5 ? -1 : 1;
    }
    const has = (px, py) => cells.has(((px + 16) % 16) + ((py + 16) % 16) * 16);
    for (const key of cells) {
      const px = key % 16, py = (key / 16) | 0;
      t.set(px, py, vary(midC, 0.92 + 0.16 * r()));
      if (!has(px + 1, py + 1)) t.set(px + 1, py + 1, dark);
      if (!has(px - 1, py) && !has(px, py - 1) && r() < 0.6) t.set(px, py, light);
    }
  }
}
P.coal_ore = (t, r) => paintOre(t, r, [0x111111, 0x2b2b2b, 0x4a4a4a], 5);
P.iron_ore = (t, r) => paintOre(t, r, [0x7b5a44, 0xd1a487, 0xf0cdb4], 4);
P.gold_ore = (t, r) => paintOre(t, r, [0x8a6a10, 0xf5c518, 0xfff27a], 4);
P.diamond_ore = (t, r) => paintOre(t, r, [0x16707a, 0x45d8e4, 0xc8fbff], 4);

P.bedrock = (t, r) => {
  const p = pal(0x161616, 0x262626, 0x363636, 0x494949, 0x5d5d5d, 0x727272);
  const n = tileNoise(r, 8);
  t.paint((x, y) => pick(p, clamp01(0.55 * n(x, y) + 0.5 * r() - 0.05)));
};

P.sand = (t, r) => {
  const p = pal(0xcfbf7e, 0xd5c687, 0xdbcd90, 0xe0d398, 0xe6daa2);
  const n = tileNoise(r, 4);
  t.paint((x, y) => {
    if (r() < 0.07) return rgb(0xbba96c);
    if (r() < 0.04) return rgb(0xf1e8c0);
    return pick(p, clamp01(0.3 * n(x, y) + 0.7 * r()));
  });
};

P.gravel = (t, r) => {
  const base = rgb(0x6c6663);
  t.paint(() => vary(base, 0.9 + 0.15 * r()));
  const tones = pal(0x9b9592, 0x6b6563, 0x8a8482, 0xaba6a2, 0x7f7570, 0x5f5a57, 0x8f8680);
  for (let k = 0; k < 30; k++) {
    const x = r.int(0, 15), y = r.int(0, 15), w = r.int(1, 2), h = r.int(1, 2);
    const c = r.pick(tones);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) t.set(x + xx, y + yy, vary(c, 0.95 + 0.1 * r()));
    t.set(x, y, vary(c, 1.15));
    t.set(x + w, y + h, rgb(0x46413f));
  }
};

P.snow = (t, r) => {
  const p = pal(0xdbe5ed, 0xe6edf2, 0xeff3f7, 0xf6f9fb, 0xffffff);
  const n = tileNoise(r, 4);
  t.paint((x, y) => pick(p, clamp01(0.5 * n(x, y) + 0.55 * r() - 0.02)));
  for (let k = 0; k < 4; k++) t.set(r.int(0, 15), r.int(0, 15), rgb(0xcfdbe6));
};

// ------------------------------------------------------------------------------------------------ wood / plants

P.log_side = (t, r) => {
  const p = pal(0x46331e, 0x523c24, 0x5e462b, 0x6a5032, 0x765a39);
  const col = []; for (let x = 0; x < 16; x++) col[x] = r();
  const n = tileNoise(r, 4);
  t.paint((x, y) => pick(p, clamp01(0.55 * col[x] + 0.2 * n(x, y) + 0.3 * r() - 0.03)));
  for (let k = 0; k < 5; k++) {
    const x = r.int(0, 15), y0 = r.int(0, 15), len = r.int(3, 9);
    for (let s = 0; s < len; s++) t.set(x, y0 + s, rgb(0x34261a));
  }
  for (let k = 0; k < 3; k++) { const x = r.int(0, 15), y = r.int(0, 15); t.set(x, y, rgb(0x8a6c45)); t.set(x, y + 1, rgb(0x806340)); }
};

function paintRings(t, r, ringA, ringB, core, bark, wobble) {
  const n = tileNoise(r, 4);
  t.paint((x, y) => {
    const dx = x - 7.5, dy = y - 7.5;
    const dm = Math.max(Math.abs(dx), Math.abs(dy)), de = Math.sqrt(dx * dx + dy * dy);
    if (dm > 6.6) return vary(r.pick(bark), 0.92 + 0.16 * r());
    const d = 0.6 * dm + 0.4 * de + (n(x, y) - 0.5) * wobble;
    let c = (Math.floor(d / 1.5) & 1) ? ringA : ringB;
    if (d < 1.1) c = core;
    return vary(c, 0.95 + 0.08 * r());
  });
}
P.log_top = (t, r) => paintRings(t, r, rgb(0xb8925a), rgb(0x9c7845), rgb(0x87673a), pal(0x46331e, 0x553e25, 0x624830), 0.9);
P.palm_log_top = (t, r) => paintRings(t, r, rgb(0xcfb27e), rgb(0xb89a68), rgb(0xa88a58), pal(0x7c6040, 0x8a6c47, 0x6f5538), 0.6);

P.palm_log = (t, r) => {
  // overlapping chevron scales (palm trunk), 4 px rings
  const base = pal(0x8e7049, 0x9a7b51, 0xa6875a, 0xb29463);
  const dark = rgb(0x5f4a2e);
  t.paint((x, y) => {
    const ring = y >> 2, yy = y & 3;
    const zig = Math.abs(((x + (ring & 1) * 4) & 7) - 3.5) > 2 ? 1 : 0; // 0/1 chevron step
    const edge = yy === 3 - zig;
    if (edge) return vary(dark, 0.9 + 0.2 * r());
    let c = pick(base, r());
    if (yy === (4 - zig) % 4) c = mul(c, 1.12);       // lit lip of the scale below the edge
    else if (yy === 2 - zig) c = mul(c, 0.9);          // shadow above the edge
    return c;
  });
  for (let k = 0; k < 6; k++) t.shade(r.int(0, 15), r.int(0, 15), 0.88);
};

const LEAF = pal(0x22521a, 0x2b601f, 0x336e25, 0x3d7c2b, 0x488a33, 0x53983b);

P.leaves = (t, r) => {
  const n = tileNoise(r, 8);
  t.paint((x, y) => {
    const c = pick(LEAF, clamp01(0.4 * n(x, y) + 0.6 * r()));
    return r() < 0.15 ? [c[0], c[1], c[2], 0] : c;
  });
  for (let k = 0; k < 8; k++) { const x = r.int(0, 15), y = r.int(0, 15); if (t.alpha(x, y)) t.set(x, y, rgb(0x66ab45)); }
};

P.palm_leaves = (t, r) => {
  const p = pal(0x3a7a22, 0x46892a, 0x529832, 0x5fa73a, 0x6cb543, 0x7cc24e);
  t.paint((x, y) => {
    // fronds: diagonal leaflets separated by slits
    const band = (x - y + 32) % 6;
    const slit = band === 0 && r() < 0.85;
    const c = pick(p, clamp01(0.35 + (band / 6) * 0.45 + 0.25 * r() - 0.1));
    if (slit || r() < 0.08) return [c[0], c[1], c[2], 0];
    return c;
  });
};

P.planks = (t, r) => {
  const tones = pal(0xa27e48, 0xac874f, 0x9a7643, 0xb08c55);
  const seam = rgb(0x6b5130);
  for (let b = 0; b < 4; b++) {
    const y0 = b * 4;
    const tone = tones[(b + r.int(0, 3)) % 4];
    const joint = (b & 1) ? r.int(9, 13) : r.int(2, 6);
    const rows = [r(), r(), r()];
    for (let y = y0; y < y0 + 4; y++) {
      for (let x = 0; x < 16; x++) {
        if (y === y0 + 3) t.set(x, y, vary(seam, 0.92 + 0.12 * r()));
        else if (x === joint) t.set(x, y, vary(seam, 1.05));
        else t.set(x, y, mul(tone, 0.9 + 0.08 * rows[y - y0] + 0.06 * r()));
      }
    }
    for (let k = 0; k < 2; k++) {
      const gy = y0 + r.int(0, 2), gx = r.int(0, 15), len = r.int(2, 5);
      for (let s = 0; s < len; s++) if ((gx + s) % 16 !== joint) t.shade(gx + s, gy, 0.88);
    }
    t.shade(joint + 1, y0, 1.06);
  }
};

P.crate = (t, r) => {
  const plank = rgb(0xb4894f), frame = rgb(0x7d5830), brace = rgb(0x986d3e);
  t.paint((x, y) => {
    const edge = x < 2 || x > 13 || y < 2 || y > 13;
    if (edge) {
      let c = vary(frame, 0.9 + 0.15 * r());
      if (x === 0 || y === 15) c = mul(c, 0.8);
      if (x === 15 || y === 0) c = mul(c, 1.08);
      return c;
    }
    const onBrace = Math.abs(x - y) <= 1 || Math.abs(x + y - 15) <= 1;
    if (onBrace) {
      let c = vary(brace, 0.92 + 0.12 * r());
      if (Math.abs(x - y) === 1 && Math.abs(x + y - 15) > 1) c = mul(c, x > y ? 0.8 : 1.1);
      if (Math.abs(x + y - 15) === 1 && Math.abs(x - y) > 1) c = mul(c, x + y > 15 ? 0.8 : 1.1);
      return c;
    }
    if (((y - 2) % 4) === 3) return mul(plank, 0.78);
    return vary(plank, 0.9 + 0.12 * r());
  });
  for (const [x, y] of [[1, 1], [14, 1], [1, 14], [14, 14]]) t.set(x, y, rgb(0x3a3632));
};

P.bookshelf = (t, r) => {
  const plank = rgb(0xa8854e), dark = rgb(0x6b5130), back = rgb(0x2a1d10);
  const colors = pal(0x8e2a2a, 0x2a4e8e, 0x2e7a3a, 0x7a5a2a, 0x6a2a7a, 0xb08a3a, 0x3a3a46, 0x9a3a20, 0x1f6a6a);
  t.fill(back);
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, vary(plank, 0.95 + 0.1 * r())); t.set(x, 15, vary(dark, 0.95 + 0.1 * r()));
    t.set(x, 7, vary(plank, 0.95 + 0.1 * r())); t.set(x, 8, vary(dark, 0.95 + 0.1 * r()));
  }
  for (const [y0, y1] of [[1, 6], [9, 14]]) {
    let x = 0;
    while (x < 16) {
      const w = r() < 0.7 ? 2 : 1;
      if (r() < 0.1) { x += 1; continue; } // gap
      const c = r.pick(colors);
      const top = y0 + (r() < 0.5 ? r.int(0, 2) : 0);
      for (let xx = 0; xx < w && x + xx < 16; xx++) {
        for (let y = top; y <= y1; y++) {
          let cc = c;
          if (xx === 0) cc = mul(c, 1.15);
          if (y === top) cc = mul(cc, 1.12);
          if (y === top + 2 && r() < 0.8) cc = mix(cc, rgb(0xd8c48a), 0.45); // label band
          t.set(x + xx, y, cc);
        }
      }
      x += w;
    }
  }
};

P.hedge = (t, r) => {
  const p = pal(0x1f4a17, 0x26581c, 0x2e6522, 0x377429, 0x418331, 0x4c923a);
  const n = tileNoise(r, 8);
  t.paint((x, y) => pick(p, clamp01(0.45 * n(x, y) + 0.55 * r())));
  for (let k = 0; k < 12; k++) {
    const x = r.int(0, 15), y = r.int(0, 15);
    t.set(x, y, rgb(0x5aa244)); t.set(x + 1, y, rgb(0x4c923a)); t.set(x, y + 1, rgb(0x1b4114));
  }
};

P.tall_grass = (t, r) => {
  t.fill([0, 0, 0], 0);
  const bladeCount = 9;
  for (let b = 0; b < bladeCount; b++) {
    let x = 1 + Math.round((b / (bladeCount - 1)) * 13) + r.int(-1, 1);
    const h = r.int(5, 13);
    const lean = r() < 0.5 ? -1 : 1;
    for (let s = 0; s < h; s++) {
      const y = 15 - s;
      const k = s / h;
      const c = mix(rgb(0x3a7424), rgb(0x86c853), k);
      t.set(x, y, vary(c, 0.95 + 0.1 * r()));
      if (s > 2 && r() < 0.28) x = Math.max(0, Math.min(15, x + lean));
    }
  }
};

function paintFlower(t, r, petal, petalDark, centre) {
  t.fill([0, 0, 0], 0);
  const stem = rgb(0x3f7a2a), leaf = rgb(0x4f9433);
  for (let y = 7; y <= 15; y++) t.set(y > 12 ? 7 : 8, y, y > 11 ? mul(stem, 0.85) : stem);
  for (const [x, y] of [[6, 11], [5, 10], [9, 12], [10, 11], [11, 10]]) t.set(x, y, leaf);
  t.set(4, 9, mul(leaf, 1.1));
  const P2 = [[7, 3], [8, 3], [6, 4], [9, 4], [6, 5], [9, 5], [7, 6], [8, 6], [5, 4], [10, 5], [7, 2], [8, 7]];
  for (const [x, y] of P2) t.set(x, y, y >= 5 ? petalDark : petal);
  t.set(7, 4, centre); t.set(8, 4, centre); t.set(7, 5, mul(centre, 0.85)); t.set(8, 5, mul(centre, 0.85));
  t.set(7, 2, mul(petal, 1.15));
}
P.flower_red = (t, r) => paintFlower(t, r, rgb(0xe0402f), rgb(0xa82a22), rgb(0xf2d43a));
P.flower_yellow = (t, r) => paintFlower(t, r, rgb(0xf6dc3c), rgb(0xd0a91f), rgb(0xd9781a));

// ------------------------------------------------------------------------------------------------ city

function paintAsphalt(t, r) {
  const c = rgb(0x38383b);
  t.paint(() => {
    const k = r();
    if (k < 0.06) return vary(c, 1.4);
    if (k < 0.11) return vary(c, 0.72);
    return vary(c, 0.9 + 0.18 * r());
  });
}
P.asphalt = paintAsphalt;

function paintRoadPaint(t, r, hex) {
  paintAsphalt(t, rngFor('asphalt'));
  const paint = rgb(hex);
  const n = tileNoise(r, 4);
  t.paint((x, y) => {
    const worn = r() < 0.06 || (n(x, y) < 0.2 && r() < 0.4);
    const p = vary(paint, 0.9 + 0.1 * r());
    return worn ? mix(p, t.rgbAt(x, y), 0.5) : p; // worn: faded paint over asphalt
  });
}
P.road_line_white = (t, r) => paintRoadPaint(t, r, 0xe9e9e4);
P.road_line_yellow = (t, r) => paintRoadPaint(t, r, 0xe6bb2a);

P.sidewalk = (t, r) => {
  const base = rgb(0xaaa69d), seam = rgb(0x878479);
  const tone = [0.98 + 0.05 * r(), 0.98 + 0.05 * r(), 0.98 + 0.05 * r(), 0.98 + 0.05 * r()];
  t.paint((x, y) => {
    const sx = x & 7, sy = y & 7;
    if (sx === 0 || sy === 0) return vary(seam, 0.95 + 0.08 * r());
    let c = mul(base, tone[(x >> 3) + (y >> 3) * 2] * (0.96 + 0.06 * r()));
    if (sx === 1 || sy === 1) c = mul(c, 1.04);
    if (sx === 7 || sy === 7) c = mul(c, 0.96);
    return c;
  });
  // a hairline crack in one slab
  let x = 9 + r.int(0, 3), y = 2;
  for (let s = 0; s < 5; s++) { t.shade(x, y, 0.8); y++; if (r() < 0.5) x += r() < 0.5 ? -1 : 1; }
};

P.concrete = (t, r) => {
  const c = rgb(0xb9b9b4);
  const n = tileNoise(r, 4);
  t.paint((x, y) => mul(c, 0.965 + 0.04 * n(x, y) + 0.035 * r()));
  for (let k = 0; k < 5; k++) t.shade(r.int(0, 15), r.int(0, 15), 0.9);
};

P.concrete_dark = (t, r) => {
  const c = rgb(0x5c5d60);
  const n = tileNoise(r, 4);
  t.paint((x, y) => vary(c, 0.95 + 0.06 * n(x, y) + 0.05 * r()));
  for (let k = 0; k < 5; k++) t.shade(r.int(0, 15), r.int(0, 15), 0.85);
};

P.plaster = (t, r) => {
  const c = rgb(0xd9c9a8);
  const n = tileNoise(r, 4);
  t.paint((x, y) => mul(c, 0.96 + 0.05 * n(x, y) + 0.03 * r()));
};

function paintStucco(t, r, hex) {
  const c = rgb(hex);
  const n = tileNoise(r, 8);
  t.paint((x, y) => {
    let f = 0.92 + 0.07 * n(x, y) + 0.09 * r();
    if (r() < 0.06) f *= 0.88;
    return mul(c, f);
  });
}
P.stucco_pink = (t, r) => paintStucco(t, r, 0xe3a0a8);
P.stucco_teal = (t, r) => paintStucco(t, r, 0x5fb3a8);

P.terracotta = (t, r) => {
  const c = rgb(0xa0583a);
  const n = tileNoise(r, 4);
  t.paint((x, y) => mul(c, 0.93 + 0.07 * n(x, y) + 0.06 * r()));
  for (let k = 0; k < 6; k++) t.shade(r.int(0, 15), r.int(0, 15), 0.88);
};

P.brick = (t, r) => {
  const mortar = pal(0xb3aa9b, 0xa59c8d, 0xbcb3a4);
  const tones = pal(0x8f4434, 0x9b4a3a, 0xa45240, 0xae5a46, 0x96483a, 0x87402f);
  const tone = []; for (let i = 0; i < 8; i++) tone.push(r.pick(tones));
  t.paint((x, y) => {
    const course = y >> 2, ry = y & 3;
    const bx = (x + (course & 1) * 4) & 15;
    const bi = bx >> 3, rx = bx & 7;
    if (ry === 3 || rx === 7) return vary(r.pick(mortar), 0.95 + 0.08 * r());
    let c = mul(tone[course * 2 + bi], 0.92 + 0.12 * r());
    if (ry === 0) c = mul(c, 1.08);
    if (ry === 2) c = mul(c, 0.9);
    if (rx === 0) c = mul(c, 1.04);
    return c;
  });
};

P.marble = (t, r) => {
  const base = rgb(0xece8e0);
  const n4 = tileNoise(r, 4), n8 = tileNoise(r, 8), n2 = tileNoise(r, 2);
  t.paint((x, y) => {
    const v = 0.6 * n2(x, y) + 0.32 * n4(x, y) + 0.08 * n8(x, y);
    const d = Math.abs(v - 0.5);
    let c = mul(base, 0.975 + 0.03 * r());
    if (d < 0.02) c = mix(c, rgb(0x9a9284), 0.65);
    else if (d < 0.045) c = mix(c, rgb(0xc2bbaf), 0.4);
    return c;
  });
};

P.tile_white = (t, r) => {
  const base = rgb(0xe6e6e1), grout = rgb(0xaeaea6);
  const tone = [0.98 + 0.04 * r(), 0.98 + 0.04 * r(), 0.98 + 0.04 * r(), 0.98 + 0.04 * r()];
  t.paint((x, y) => {
    const sx = x & 7, sy = y & 7;
    if (sx === 7 || sy === 7) return grout;
    let c = mul(base, tone[(x >> 3) + (y >> 3) * 2] * (0.985 + 0.02 * r()));
    if (sx === 0 || sy === 0) c = mul(c, 1.03);
    if (sx === 6 || sy === 6) c = mul(c, 0.95);
    return c;
  });
  t.set(2, 2, rgb(0xffffff)); t.set(10, 10, rgb(0xffffff));
};

P.carpet_red = (t, r) => {
  const c = rgb(0x8e2a2a);
  t.paint((x, y) => {
    let f = 0.95 + 0.07 * r();
    const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
    if (d > 4.5 && d < 6) f *= 1.18;
    if (d < 1.5) f *= 1.15;
    if (x === 0 || y === 0 || x === 15 || y === 15) f *= 0.8;
    if (x === 1 || y === 1 || x === 14 || y === 14) f *= 1.12;
    return mul(c, f);
  });
};

function paintWool(t, r, hex) {
  const c = rgb(hex);
  const n = tileNoise(r, 8);
  t.paint((x, y) => {
    let f = 0.94 + 0.06 * n(x, y) + 0.06 * r();
    if (((x + y * 2) & 3) === 0) f *= 0.95;
    if (((x * 3 + y) & 7) === 1) f *= 1.04;
    return vary(c, f);
  });
}
for (const [name, hex] of [['wool_red', 0xb02e26], ['wool_blue', 0x3c44aa], ['wool_yellow', 0xfed83d], ['wool_green', 0x5e7c16],
  ['wool_white', 0xe9ecec], ['wool_black', 0x1d1d21], ['wool_orange', 0xf9801d], ['wool_purple', 0x8932b8]]) {
  P[name] = (t, r) => paintWool(t, r, hex);
}

P.hazard = (t, r) => {
  const yel = rgb(0xe8b923), blk = rgb(0x262624);
  t.paint((x, y) => {
    const s = ((x + y) & 7) < 4;
    let c = vary(s ? yel : blk, 0.92 + 0.1 * r());
    if (s && r() < 0.06) c = mul(c, 0.72);
    return c;
  });
};

P.metal = (t, r) => {
  const c = rgb(0x9aa3a8);
  const rows = []; for (let y = 0; y < 16; y++) rows[y] = 0.95 + 0.08 * r();
  t.paint((x, y) => mul(c, rows[y] * (0.98 + 0.04 * r())));
  for (let i = 0; i < 16; i++) { t.shade(i, 0, 1.12); t.shade(0, i, 1.08); t.shade(i, 15, 0.78); t.shade(15, i, 0.84); }
  for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) {
    t.set(x, y, rgb(0xd7dde0)); t.set(x + 1, y, rgb(0xaab2b6)); t.set(x, y + 1, rgb(0xaab2b6)); t.set(x + 1, y + 1, rgb(0x5d656a));
  }
};

P.roof = (t, r) => {
  const c = rgb(0x434347);
  t.paint(() => {
    const k = r();
    if (k < 0.08) return vary(c, 1.35);
    if (k < 0.14) return vary(c, 0.7);
    return vary(c, 0.92 + 0.14 * r());
  });
};

P.solar = (t, r) => {
  const a = rgb(0x1e2c4a), b = rgb(0x2b4170), frame = rgb(0x9aa6b8), line = rgb(0x16203a);
  t.paint((x, y) => {
    const sx = x & 7, sy = y & 7;
    if (sx === 0 || sy === 0) return vary(frame, 0.95 + 0.08 * r());
    if (sx === 4 || sy === 4) return line;
    return mul(mix(b, a, (sx + sy) / 14), 0.96 + 0.06 * r());
  });
  for (let k = 0; k < 6; k++) t.blend(9 + k, 6 - k, rgb(0x8fb0e0), 0.45);
  for (let k = 0; k < 3; k++) t.blend(2 + k, 13 - k, rgb(0x8fb0e0), 0.35);
};

/** Window frame. a = 240 on emissive tiles marks "no glow" pixels (see GLOW_OFF). */
function windowFrame(t, a = 255) {
  const f = rgb(0x8e969c);
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, mul(f, 1.15), a); t.set(0, i, mul(f, 1.08), a);
    t.set(i, 15, mul(f, 0.72), a); t.set(15, i, mul(f, 0.8), a);
  }
  for (let i = 1; i < 15; i++) { t.blend(i, 1, [0, 0, 0], 0.22); t.blend(1, i, [0, 0, 0], 0.18); }
}

P.window = (t, r, v) => {
  const top = rgb(0x416b8a), bot = rgb(0x1d3245);
  t.paint((x, y) => mul(mix(top, bot, y / 15), 0.97 + 0.05 * r()));
  const s = v === 1 ? 13 : 8;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = x + y;
      if (d >= s && d <= s + 2) t.blend(x, y, rgb(0x8fb3cf), 0.5);
      else if (d === s + 4) t.blend(x, y, rgb(0x8fb3cf), 0.25);
    }
  }
  windowFrame(t);
};

/**
 * Lit window, night look: the bright room behind the glass (warm ceiling light, blinds, silhouettes, curtains). It is
 * not a block face texture: the chunk shader samples it (same variant, NIGHT_TILES[...] cells further in the atlas)
 * for the night glow of 'window_lit' faces, so nights keep the warm detailed windows while days show glass.
 */
function paintLitRoom(t, v) {
  const r = rngFor('window_lit', v); // the original lit-window noise
  const top = rgb(0xfff1c2), bot = rgb(0xf2b65a);
  t.paint((x, y) => mul(mix(top, bot, y / 15), 0.98 + 0.04 * r()));
  if (v === 0) {
    for (let y = 2; y < 6; y++) for (let x = 5; x < 11; x++) t.blend(x, y, rgb(0xffffff), 0.35 * (1 - Math.abs(x - 7.5) / 3));
  } else if (v === 1) { // blinds
    for (let y = 1; y < 15; y++) if (y & 1) for (let x = 1; x < 15; x++) t.blend(x, y, rgb(0xb88a3e), 0.4);
    for (let y = 2; y < 12; y++) t.set(12, y, rgb(0x8a6a3a));
  } else if (v === 2) { // silhouette (someone at the window) + ceiling lamp
    const sil = rgb(0x7a5230);
    for (const [x, y] of [[9, 7], [10, 7], [9, 8], [10, 8], [9, 9], [10, 9]]) t.set(x, y, sil);
    for (let y = 10; y < 15; y++) { const w = y === 10 ? 1 : 2; for (let x = 10 - w; x <= 9 + w; x++) t.set(x, y, sil); }
    for (let x = 3; x <= 5; x++) t.set(x, 2, rgb(0xfffbe8));
    t.set(4, 1, rgb(0x9a8a6a));
  } else { // curtains + plant
    const cur = rgb(0xb4533a);
    for (let y = 1; y < 15; y++) {
      for (const x of [1, 2, 3, 12, 13, 14]) t.set(x, y, mul(cur, (x & 1) ? 1.08 : 0.88));
    }
    for (const x of [3, 12]) t.set(x, 9, rgb(0xe8c070));
    const leaf = rgb(0x3d7a2a);
    for (const [x, y] of [[7, 10], [8, 10], [6, 11], [9, 11], [7, 11], [8, 11], [7, 9], [9, 9]]) t.set(x, y, leaf);
    for (let x = 6; x <= 9; x++) { t.set(x, 13, rgb(0x9a5a30)); t.set(x, 12, rgb(0xb06a3a)); }
  }
}
P.window_lit_night = (t, r, v) => {
  paintLitRoom(t, v);
  windowFrame(t, GLOW_OFF);
};

/**
 * Lit window, day look: glazing with a warm room behind it (the plain window's glass gradient tinted toward amber,
 * faint interior shapes from the night tile, a soft reflection streak). Alpha is the glow mask exactly as on every
 * emissive tile (255 = glows at night, frame = GLOW_OFF), so the shader's glow mask is unchanged.
 */
const WIN_AMBER = rgb(0xe8a050);
P.window_lit = (t, r, v) => {
  const room = new PixelTile(16, 16);
  paintLitRoom(room, v);
  const top = mul(mix(rgb(0x416b8a), WIN_AMBER, 0.27), 0.84), bot = mul(mix(rgb(0x1d3245), WIN_AMBER, 0.27), 0.84);
  // interior detail = the room's brightness relative to its smooth gradient (blinds, silhouettes, curtains)
  const ref = (y) => 0.98 * (255 + (242 - 255) * y / 15 + 241 + (182 - 241) * y / 15 + 194 + (90 - 194) * y / 15) / 3;
  t.paint((x, y) => {
    const c = room.rgbAt(x, y);
    const k = Math.min(1.15, ((c[0] + c[1] + c[2]) / 3) / ref(y));
    const glass = mul(mix(top, bot, y / 15), (0.6 + 0.4 * k) * (0.97 + 0.05 * r()));
    return mix(glass, mul(c, 0.45), 0.18);
  });
  const s = v === 1 ? 13 : 8;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = x + y;
      if (d >= s && d <= s + 2) t.blend(x, y, rgb(0x8fb3cf), 0.3);
      else if (d === s + 4) t.blend(x, y, rgb(0x8fb3cf), 0.14);
    }
  }
  windowFrame(t, GLOW_OFF);
};

P.glass = (t, r) => {
  t.fill(rgb(0xcfe7ef), 40);
  const f = rgb(0xe8f4f7);
  for (let i = 0; i < 16; i++) { t.set(i, 0, f, 235); t.set(i, 15, mul(f, 0.88), 235); t.set(0, i, f, 235); t.set(15, i, mul(f, 0.9), 235); }
  for (const [x, y] of [[3, 6], [4, 5], [5, 4], [6, 3]]) t.set(x, y, rgb(0xffffff), 190);
  for (const [x, y] of [[3, 9], [4, 8], [5, 7], [6, 6], [7, 5], [8, 4], [9, 3]]) t.set(x, y, rgb(0xffffff), 120);
  for (const [x, y] of [[11, 13], [12, 12], [13, 11]]) t.set(x, y, rgb(0xffffff), 110);
};

P.lamp = (t, r) => {
  const frame = [...rgb(0x48463f), GLOW_OFF], frame2 = [...rgb(0x66635a), GLOW_OFF];
  t.paint((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return frame;
    if (x === 1 || y === 1 || x === 14 || y === 14) return frame2;
    if (x === 7 || x === 8 || y === 7 || y === 8) return [...mix(frame2, rgb(0xffe7a0), 0.25), GLOW_OFF];
    const qx = x < 8 ? 4.5 : 10.5, qy = y < 8 ? 4.5 : 10.5;
    const d = Math.hypot(x - qx, y - qy) / 4.2;
    return mix(rgb(0xfffef2), rgb(0xffd473), clamp01(d));
  });
};

function paintNeon(t, r, bgHex, glowHex, coreHex) {
  const bg = rgb(bgHex), glow = rgb(glowHex), core = rgb(coreHex);
  t.paint(() => [...vary(bg, 0.85 + 0.25 * r()), GLOW_OFF]);
  for (let x = 0; x < 16; x++) {
    t.set(x, 4, mix(bg, glow, 0.2)); t.set(x, 11, mix(bg, glow, 0.2));
    t.set(x, 5, mix(bg, glow, 0.5)); t.set(x, 10, mix(bg, glow, 0.5));
    t.set(x, 6, glow); t.set(x, 9, glow);
    t.set(x, 7, core); t.set(x, 8, mix(core, glow, 0.35));
  }
  for (const x of [3, 11]) {
    t.set(x, 5, rgb(0x2a2a2e), GLOW_OFF); t.set(x, 10, rgb(0x2a2a2e), GLOW_OFF);
    t.set(x, 4, rgb(0x3a3a40), GLOW_OFF); t.set(x, 11, rgb(0x3a3a40), GLOW_OFF);
  }
}
P.neon_pink = (t, r) => paintNeon(t, r, 0x1e0f1a, 0xff3fb4, 0xffe0f4);
P.neon_blue = (t, r) => paintNeon(t, r, 0x0c1622, 0x3fd5ff, 0xe0faff);

P.sandstone = (t, r) => {
  const base = rgb(0xd8c98f);
  t.paint((x, y) => {
    let f = 0.95 + 0.07 * r();
    if (y < 3) f *= 1.05;
    if (y === 3) f *= 0.9;
    if (y >= 12) f *= 0.97;
    if (y === 12 || y === 15) f *= 0.88;
    return mul(base, f);
  });
  for (let k = 0; k < 6; k++) t.shade(r.int(0, 15), r.int(4, 11), 0.9);
};
P.sandstone_top = (t, r) => {
  const base = rgb(0xdccd93);
  t.paint(() => mul(base, 0.96 + 0.06 * r()));
};

P.tnt_side = (t, r) => {
  const red = rgb(0xc8372a), redD = rgb(0x9a2a20), redL = rgb(0xdd4a3c), white = rgb(0xefece4), ink = rgb(0x1a1a1a);
  t.paint((x, y) => {
    if (y >= 4 && y <= 10) return mul(white, 0.95 + 0.06 * r());
    const k = x & 3;
    let c = k === 0 ? redD : k === 1 ? redL : red;
    if (y === 3 || y === 11) c = mul(c, 0.8);
    return mul(c, 0.95 + 0.08 * r());
  });
  const T = ['###', '.#.', '.#.', '.#.', '.#.'];
  const N = ['#..#', '##.#', '#.##', '#..#', '#..#'];
  const glyph = (g, ox) => { for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < g[gy].length; gx++) if (g[gy][gx] === '#') t.set(ox + gx, 5 + gy, ink); };
  glyph(T, 2); glyph(N, 6); glyph(T, 11);
};

function paintTntEnd(t, r, fuse) {
  const red = rgb(0xc8372a), rim = rgb(0x8e261d), hole = rgb(0x3a1a14);
  t.paint((x, y) => {
    const cx = (x & 7) - 3.5, cy = (y & 7) - 3.5;
    const d = Math.sqrt(cx * cx + cy * cy);
    let c = red;
    if (d > 3.3) c = rim;
    else if (d < 1.2) c = mul(red, 0.8);
    else if (cx + cy < -1) c = mul(red, 1.12);
    return mul(c, 0.95 + 0.08 * r());
  });
  if (fuse) {
    for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) t.set(x, y, hole);
    t.set(7, 6, rgb(0x6a6a6a)); t.set(8, 5, rgb(0x8a8a8a)); t.set(8, 6, rgb(0x777777));
  }
}
P.tnt_top = (t, r) => paintTntEnd(t, r, true);
P.tnt_bottom = (t, r) => { paintTntEnd(t, r, false); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.shade(x, y, 0.85); };

// ------------------------------------------------------------------------------------------------ water / overlays

/** Water tile frame f (0..WATER_FRAMES-1): blue with lighter animated ripples, alpha ~0.75. */
export function paintWaterFrame(t, f) {
  const deep = rgb(0x2252b0), mid = rgb(0x2c68c8), light = rgb(0x4a88dc), hi = rgb(0x8fbdf2);
  const ph = (f / WATER_FRAMES) * Math.PI * 2;
  const r = rngFor('water');
  const jit = []; for (let i = 0; i < 256; i++) jit.push(r());
  t.paint((x, y) => {
    const a = Math.sin(((x + 2 * y) / 16) * Math.PI * 2 + ph);
    const b = Math.sin(((3 * x - y) / 16) * Math.PI * 2 - ph * 2);
    const c = Math.sin(((y) / 16) * Math.PI * 4 + ph);
    const v = (a * 0.45 + b * 0.35 + c * 0.2) + (jit[y * 16 + x] - 0.5) * 0.25;
    let col = mid;
    if (v > 0.62) col = hi; else if (v > 0.3) col = light; else if (v < -0.45) col = deep;
    return [col[0], col[1], col[2], v > 0.62 ? 205 : 190];
  });
}
P.water = (t) => paintWaterFrame(t, 0);

let crackOrder = null;
/** Ordered list of crack pixels growing from the centre (shared by all destroy stages). */
function crackPixels() {
  if (crackOrder) return crackOrder;
  const r = rngFor('destroy');
  const order = [];
  const seen = new Set();
  const addPx = (x, y) => {
    if (x < 0 || y < 0 || x > 15 || y > 15) return false;
    const k = x + y * 16;
    if (seen.has(k)) return true;
    seen.add(k); order.push([x, y]);
    return true;
  };
  const walkers = [];
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const start = [[7, 7], [8, 8], [8, 7]];
  for (const s of start) addPx(s[0], s[1]);
  for (let i = 0; i < 6; i++) {
    const d = dirs[(i * 3 + r.int(0, 1)) % 8];
    walkers.push({ x: 7 + (d[0] > 0 ? 1 : 0), y: 7 + (d[1] > 0 ? 1 : 0), d, life: r.int(6, 11), branch: true });
  }
  let guard = 0;
  while (walkers.length && guard++ < 400) {
    for (let w = walkers.length - 1; w >= 0; w--) {
      const k = walkers[w];
      // wander: mostly keep heading, sometimes deviate by 45 degrees
      let d = k.d;
      if (r() < 0.35) {
        const di = dirs.findIndex((q) => q[0] === d[0] && q[1] === d[1]);
        d = dirs[(di + (r() < 0.5 ? 1 : 7)) % 8];
      }
      k.x += d[0]; k.y += d[1];
      if (!addPx(k.x, k.y)) { walkers.splice(w, 1); continue; }
      if (k.branch && r() < 0.18) walkers.push({ x: k.x, y: k.y, d: dirs[r.int(0, 7)], life: r.int(2, 5), branch: false });
      if (--k.life <= 0) walkers.splice(w, 1);
    }
  }
  crackOrder = order;
  return order;
}

/** Transparent tile with progressively more dark crack pixels (stage 0..9). */
export function paintDestroy(t, stage) {
  t.fill([0, 0, 0], 0);
  const px = crackPixels();
  const n = Math.max(3, Math.round(px.length * Math.pow((stage + 1) / DESTROY_STAGES, 1.15)));
  for (let i = 0; i < n && i < px.length; i++) {
    const [x, y] = px[i];
    t.set(x, y, [18, 16, 14], 215);
    if (stage >= 3) {
      if (t.alpha(x + 1, y + 1) === 0 && x < 15 && y < 15) t.set(x + 1, y + 1, [230, 230, 225], 70);
    }
  }
}

// ------------------------------------------------------------------------------------------------ entry point

/** Fallback: soft noise in the block colour (never crashes on unknown names). */
function paintFallback(t, r, hex) {
  const c = rgb(hex);
  const n = tileNoise(r, 4);
  t.paint((x, y) => vary(c, 0.92 + 0.08 * n(x, y) + 0.08 * r()));
}

/** True if a painter exists for this texture name. */
export const hasPainter = (name) => !!P[name] || /^destroy_\d$/.test(name);

/**
 * Paint texture `name` (variant index `variant`) into a new 16x16 PixelTile.
 * colorHint (0xRRGGBB) is used by the fallback for unknown names.
 */
export function paintTexture(name, variant = 0, colorHint = 0x888888) {
  const t = new PixelTile(16, 16);
  const m = /^destroy_(\d)$/.exec(name);
  if (m) { paintDestroy(t, +m[1]); return t; }
  const painter = P[name];
  const r = rngFor(name, variant);
  if (painter) {
    try { painter(t, r, variant); return t; } catch (e) { /* fall through to fallback */ }
  }
  paintFallback(t, r, colorHint);
  return t;
}
