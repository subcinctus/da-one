// Blocky "BLOCK CITY" logo: a 5x7 pixel font where every pixel is drawn as an extruded, bevelled block
// (stone with grass caps for BLOCK, gold for CITY), plus a tiny procedural grass-block texture for the spinning
// loading cube. Canvas-only (no assets), browser-side helpers are only called from the UI.

const G = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  ':': ['.', '#', '.', '.', '.', '#', '.'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
};

/** Pixel grid {w, h, px: Uint8Array} of a text line in the 5x7 font (1 column gap between glyphs). */
export function textGrid(text) {
  const chars = String(text).toUpperCase().split('').map((ch) => G[ch] || G['?']);
  let w = 0;
  chars.forEach((g, i) => { w += g[0].length + (i ? 1 : 0); });
  const h = 7;
  const px = new Uint8Array(w * h);
  let x0 = 0;
  chars.forEach((g, i) => {
    if (i) x0 += 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] === '#') px[y * w + x0 + x] = 1;
    x0 += g[0].length;
  });
  return { w, h, px };
}

// deterministic speckle so the logo looks the same every time
const speck = (x, y, s) => {
  let h = Math.imul(x * 73856093 ^ y * 19349663 ^ s * 83492791, 0x27d4eb2d);
  h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000;
};

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

const STYLES = {
  stone: { top: '#d9d9d9', bottom: '#8c8c8c', depth: '#2a2a2e', grass: true },
  gold: { top: '#ffe680', bottom: '#f08c00', depth: '#5e2c00', grass: false },
  white: { top: '#ffffff', bottom: '#c9ced6', depth: '#1c1f26', grass: false },
};

/**
 * Draw one line of block text. (x, y) = top-left of the face area, P = block size in px.
 * style: 'stone' | 'gold' | 'white' (or an object like STYLES.*).
 */
export function drawBlockText(g, text, x, y, P, style = 'stone', seed = 1) {
  const st = typeof style === 'string' ? STYLES[style] : style;
  const grid = textGrid(text);
  const D = Math.max(2, Math.round(P * 0.42)); // extrusion depth
  // extrusion (down-right), drawn first
  for (let d = D; d >= 1; d--) {
    g.fillStyle = shade(st.depth, 0.7 + 0.6 * (1 - d / D));
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
      if (grid.px[j * grid.w + i]) g.fillRect(x + i * P + d * 0.55, y + j * P + d, P, P);
    }
  }
  // faces
  const bev = Math.max(1, Math.round(P / 7));
  for (let j = 0; j < grid.h; j++) {
    const t = j / (grid.h - 1);
    for (let i = 0; i < grid.w; i++) {
      if (!grid.px[j * grid.w + i]) continue;
      const fx = x + i * P, fy = y + j * P;
      const n = speck(i, j, seed);
      const base = mixHexRaw(st.top, st.bottom, t);
      g.fillStyle = shade(base, 0.92 + n * 0.16);
      g.fillRect(fx, fy, P, P);
      // pixel speckles (texture)
      const q = Math.max(1, Math.floor(P / 4));
      for (let k = 0; k < 3; k++) {
        const sx = Math.floor(speck(i * 3 + k, j, seed + 7) * (P - q));
        const sy = Math.floor(speck(i, j * 3 + k, seed + 11) * (P - q));
        g.fillStyle = shade(base, speck(i + k, j + k, seed + 3) > 0.5 ? 1.12 : 0.84);
        g.fillRect(fx + sx, fy + sy, q, q);
      }
      // bevel
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(fx, fy, P, bev); g.fillRect(fx, fy, bev, P);
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.fillRect(fx, fy + P - bev, P, bev); g.fillRect(fx + P - bev, fy, bev, P);
      // grass cap on exposed tops
      if (st.grass && (j === 0 || !grid.px[(j - 1) * grid.w + i])) {
        const gh = Math.round(P * 0.34);
        g.fillStyle = '#5fae3e';
        g.fillRect(fx, fy, P, gh);
        g.fillStyle = '#7fcf55';
        g.fillRect(fx, fy, P, Math.max(1, Math.round(gh * 0.4)));
        g.fillStyle = '#4a8f2d';
        for (let k = 0; k < 4; k++) {
          const dx = Math.floor((k / 4) * P), w = Math.ceil(P / 4);
          const drip = Math.round(speck(i * 4 + k, j, seed + 5) * P * 0.22);
          g.fillRect(fx + dx, fy + gh, w, drip);
        }
      }
    }
  }
  return { width: grid.w * P + D, height: grid.h * P + D };
}

function mixHexRaw(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) + ((((pb >> s) & 255) - ((pa >> s) & 255)) * t));
  return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

/**
 * Create the stacked BLOCK / CITY logo canvas sized for `cssWidth` CSS pixels.
 * Returns a canvas whose CSS width should be set to cssWidth.
 */
export function createLogoCanvas(cssWidth = 460) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const top = textGrid('BLOCK'), bot = textGrid('CITY');
  const cols = Math.max(top.w, bot.w) + 1;
  const P = Math.max(4, Math.floor((cssWidth * dpr) / cols));
  const D = Math.max(2, Math.round(P * 0.42));
  const rows = 7 + 2 + 7;
  const c = document.createElement('canvas');
  c.width = cols * P + D + 2;
  c.height = rows * P + D + Math.round(P * 0.4) + 2;
  c.className = 'bc-logo';
  const g = c.getContext('2d');
  const ox = (w) => Math.round(((cols - w) * P) / 2);
  drawBlockText(g, 'BLOCK', ox(top.w), Math.round(P * 0.4), P, 'stone', 3);
  drawBlockText(g, 'CITY', ox(bot.w), Math.round(P * 0.4) + 9 * P, P, 'gold', 9);
  c.style.width = Math.round(c.width / dpr) + 'px';
  return c;
}

/** 16x16 procedural grass-block textures for the loading cube: {top, side, bottom} data URLs. */
export function grassBlockTextures() {
  const mk = (fn) => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { g.fillStyle = fn(x, y); g.fillRect(x, y, 1, 1); }
    return c.toDataURL();
  };
  const grass = (x, y) => shade('#5d9b3a', 0.82 + speck(x, y, 21) * 0.36);
  const dirt = (x, y) => shade('#86603c', 0.78 + speck(x, y, 33) * 0.4);
  const side = (x, y) => {
    const edge = 3 + Math.floor(speck(x, 0, 44) * 2.4);
    return y < edge ? grass(x, y) : dirt(x, y);
  };
  return { top: mk(grass), side: mk(side), bottom: mk(dirt) };
}
