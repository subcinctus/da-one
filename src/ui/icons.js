// Item icons for the HUD / inventory / shops: Minecraft-style 16x16 pixel sprites for weapons and tools (drawn once
// into data: URLs), block icons from the world texture atlas (cached data: URLs) with a shaded-cube fallback, and a
// few SVG snippets (wanted star). Browser-only parts are lazy, so the module stays importable from Node.
import { BLOCKS } from '../world/blocks.js';
import { WEAPONS } from '../data/weapons.js';
import { TOOLS } from '../data/items.js';

const PAL = {
  k: '#17181c', // outline
  d: '#353941', // dark metal
  m: '#585f6a', // metal
  l: '#8a939f', // light metal
  h: '#cdd5de', // highlight
  w: '#5a3a1e', // dark wood
  W: '#94643a', // wood
  y: '#c48d52', // light wood
  b: '#3e2a1a', // grip / leather
  r: '#a5281e', // red
  R: '#e5533f', // light red
  g: '#3f5a26', // olive
  G: '#68873f', // light olive
  o: '#26351a', // dark olive
  s: '#e3b07a', // skin
  S: '#b27b47', // skin shade
  c: '#55c8f5', // lens
  f: '#f3a21b', // orange
};

/** 16x16 sprites (rows of 16 chars, '.' = transparent). Facing right. */
export const SPRITES = {
  pistol: [
    '................',
    '................',
    '................',
    '................',
    '...kkkkkkkkkkkk.',
    '...khhhhhhhhhhkk',
    '...kllllllllllk.',
    '...kmmmmmmmmmmk.',
    '...kkkkkkdkkkkk.',
    '...kbbbkkdk.....',
    '..kbbbbk.kk.....',
    '..kbbbbk........',
    '..kbbbk.........',
    '..kkkkk.........',
    '................',
    '................',
  ],
  smg: [
    '................',
    '................',
    '................',
    '................',
    '.....kkkkkkkkk..',
    'kkk.kllllllllhkk',
    'kmkkmmmmmmmmmmmk',
    'kmmmmddddddddkk.',
    'kkkkkkkdkkdkk...',
    '.....kbbk.kdk...',
    '.....kbbk.kdk...',
    '....kbbbk.kdk...',
    '....kkkk..kdk...',
    '..........kkk...',
    '................',
    '................',
  ],
  shotgun: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......kkkkkkkkk',
    'kkk...klllllllhk',
    'kWWk.kmmmmmmmmmk',
    'kyWWkkkkkkkkkkkk',
    'kWWWWdkkyWWWWWk.',
    '.kWWWkdkkkkkkkk.',
    '..kkkkkk........',
    '................',
    '................',
    '................',
    '................',
  ],
  rifle: [
    '................',
    '................',
    '................',
    '................',
    '..........k.....',
    'kk...kkkkkkkkkkk',
    'kWk.kllllllllllk',
    'kWWkkmmmmmmmmmmk',
    'kyWWWmmkkkkkkkkk',
    'kWWWkkdkmmk.....',
    '.kkkk.dk.kmk....',
    '......kk..kmk...',
    '...........kk...',
    '................',
    '................',
    '................',
  ],
  sniper: [
    '................',
    '................',
    '................',
    '....kkkkkkkk....',
    '...kcllllllhk...',
    '....kkkkkkkk....',
    '......k..k......',
    'kk..kkkkkkkkkkkk',
    'kWkkmmmmmmmmmmmk',
    'kyWWWkkkkkkkkkkk',
    'kWWWkdk.........',
    '.kkkkkk.........',
    '................',
    '................',
    '................',
    '................',
  ],
  rpg: [
    '................',
    '................',
    '................',
    '................',
    '...........kk...',
    'kkkkkkkkkkkrRk..',
    'kGGGGGGGGGkrRRk.',
    'kggggggggggkrrRk',
    'kooooooooookrrk.',
    'kkkkkdkkkkkkrk..',
    '....kbk....kk...',
    '....kbk.........',
    '....kkk.........',
    '................',
    '................',
    '................',
  ],
  grenade: [
    '................',
    '................',
    '......kkk.......',
    '.....kl.lk......',
    '......kmk.kk....',
    '.....kkmkkk.k...',
    '....kGGGGGk.k...',
    '...kGGgGGgGkk...',
    '..kGgGGgGGgGk...',
    '..kGGgGGgGGgk...',
    '..kgGGgGGgGgk...',
    '..kggGgggGggk...',
    '...kogggggok....',
    '....kkoookk.....',
    '......kkk.......',
    '................',
  ],
  bat: [
    '............kkk.',
    '...........kyyWk',
    '..........kyyWWk',
    '.........kyyWWk.',
    '........kyyWWk..',
    '.......kyyWWk...',
    '......kyWWk.....',
    '.....kyWWk......',
    '....kyWWk.......',
    '...kyWWk........',
    '..kbWk..........',
    '.kbbk...........',
    'kbbk............',
    'kkk.............',
    '................',
    '................',
  ],
  fist: [
    '................',
    '................',
    '....kkkkkkkk....',
    '...ksskssksskk..',
    '...ksskssksssk..',
    '..kkSskSskSssk..',
    '..ksskkkkkkkSk..',
    '..ksssssssssSk..',
    '..ksssssssssk...',
    '..kSssssssSSk...',
    '...kSSsssSSk....',
    '....kSSSSSk.....',
    '....kbbbbbk.....',
    '....kbbbbbk.....',
    '....kkkkkkk.....',
    '................',
  ],
  pickaxe: [
    '................',
    '...kkkkkk.......',
    '..khhhhllkk.....',
    '...kkkkkmlkk....',
    '......kkkmlk....',
    '.....kWk.kmlk...',
    '....kWWk..kmlk..',
    '...kWWk...kmlk..',
    '..kWWk.....kmlk.',
    '.kWWk......kmlk.',
    'kWWk.......kmk..',
    'kWk........kmk..',
    'kk..........k...',
    '................',
    '................',
    '................',
  ],
  axe: [
    '................',
    '........kkkk....',
    '.......khhllk...',
    '......khllllmk..',
    '......kllllmmk..',
    '.....kkkllmmk...',
    '....kWk.kmmk....',
    '...kWWk..kk.....',
    '..kWWk..........',
    '.kWWk...........',
    'kWWk............',
    'kWk.............',
    'kk..............',
    '................',
    '................',
    '................',
  ],
  shovel: [
    '...........kkk..',
    '..........khhlk.',
    '.........khllmk.',
    '........kklmmk..',
    '.......kWkkkk...',
    '......kWWk......',
    '.....kWWk.......',
    '....kWWk........',
    '...kWWk.........',
    '..kWWk..........',
    '.kbbk...........',
    'kbbk............',
    'kkk.............',
    '................',
    '................',
    '................',
  ],
};

const _urlCache = new Map();
const hasDOM = () => typeof document !== 'undefined';

/** Draw a sprite (rows of chars) into a new canvas at `scale` px per pixel. */
export function spriteCanvas(rows, scale = 1) {
  if (!hasDOM()) return null;
  const c = document.createElement('canvas');
  c.width = 16 * scale; c.height = 16 * scale;
  const g = c.getContext('2d');
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const col = PAL[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}

/** Sprite name for a weapon / tool id (null if no pixel art exists). */
export function spriteFor(kind, id) {
  if (SPRITES[id]) return id;
  if (kind === 'weapon') {
    const w = WEAPONS[id];
    if (w && w.kind === 'hitscan') return w.auto ? 'rifle' : 'pistol';
    if (w && w.kind === 'projectile') return 'rpg';
    if (w && w.kind === 'throw') return 'grenade';
    if (w && w.kind === 'melee') return 'bat';
  }
  return null;
}

/** Shaded isometric cube icon (fallback when the texture atlas is unavailable). */
function fallbackCubeURL(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const r = (color >> 16) & 255, gr = (color >> 8) & 255, b = color & 255;
  const shade = (f) => `rgb(${Math.round(r * f)},${Math.round(gr * f)},${Math.round(b * f)})`;
  const face = (pts, col) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); g.fillStyle = col; g.fill(); };
  face([16, 2, 30, 9, 16, 16, 2, 9], shade(1.08));
  face([2, 9, 16, 16, 16, 31, 2, 24], shade(0.82));
  face([30, 9, 16, 16, 16, 31, 30, 24], shade(0.64));
  return c.toDataURL();
}

/**
 * data: URL for an item's icon. `world` (game.world) supplies block icons via textures.getIconURL / getIcon.
 * Weapons/tools use the pixel sprites (emoji fallback returned as {emoji}).
 * Returns {url} or {emoji} or null.
 */
export function itemIconInfo(item, world) {
  if (!item) return null;
  const key = item.kind + ':' + item.id;
  const cached = _urlCache.get(key);
  if (cached) return cached;
  if (!hasDOM()) return null;
  let info = null;
  if (item.kind === 'block') {
    let url = '';
    const tex = world && world.textures;
    try {
      if (tex && typeof tex.getIconURL === 'function') url = tex.getIconURL(item.id) || '';
      else if (tex && typeof tex.getIcon === 'function') { const c = tex.getIcon(item.id); url = c ? c.toDataURL() : ''; }
    } catch (e) { url = ''; }
    if (!url) {
      // atlas not ready yet: do not cache a fallback forever, retry later
      const def = BLOCKS[item.id];
      return { url: fallbackCubeURL(def ? def.color : 0x888888), temp: true };
    }
    info = { url };
  } else if (item.kind === 'weapon' || item.kind === 'tool') {
    const name = spriteFor(item.kind, item.id);
    if (name) {
      const c = spriteCanvas(SPRITES[name], 1);
      info = { url: c.toDataURL(), pixel: true };
    } else {
      const emoji = item.kind === 'weapon' ? (WEAPONS[item.id] && WEAPONS[item.id].icon) : (TOOLS[item.id] && TOOLS[item.id].icon);
      info = { emoji: emoji || '?' };
    }
  }
  if (info) _urlCache.set(key, info);
  return info;
}

/** Fill an element with an item's icon (img or emoji span). Reuses the existing child when possible. */
export function setIcon(el, item, world) {
  const info = itemIconInfo(item, world);
  const want = info ? (info.url || 'emoji:' + info.emoji) : '';
  if (el.__icon === want) return;
  el.__icon = info && info.temp ? '' : want;
  el.textContent = '';
  if (!info) return;
  if (info.url) {
    const img = document.createElement('img');
    img.src = info.url;
    img.alt = '';
    img.draggable = false;
    img.className = 'bc-ico' + (info.pixel ? ' px' : '');
    el.appendChild(img);
  } else {
    const s = document.createElement('span');
    s.className = 'bc-ico emoji';
    s.textContent = info.emoji;
    el.appendChild(s);
  }
}

/** SVG markup of one 5-point star (viewBox 0 0 24 24). */
export const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.9l-6.4 3.5L7 14.3 1.7 9.3l7.2-.9z"/></svg>';
