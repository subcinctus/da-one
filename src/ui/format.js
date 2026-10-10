// Pure formatting / parsing helpers shared by the UI modules. No DOM access: importable from Node for unit tests.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 1234567 -> '1,234,567' (integers, negative allowed). */
export function groupDigits(n) {
  n = Math.round(Number(n) || 0);
  const neg = n < 0;
  let s = String(Math.abs(n));
  let out = '';
  while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
  return (neg ? '-' : '') + s + out;
}

/** Money as GTA shows it: '$1,234'. */
export const formatMoney = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-$' : '$') + groupDigits(Math.abs(v));
};

/** Signed money delta: '+$500' / '-$100'. */
export const formatDelta = (d) => (d >= 0 ? '+$' : '-$') + groupDigits(Math.abs(Math.round(d)));

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

/** Hours (0..24, fractional) -> '14:05'. */
export function formatClock(hours) {
  let h = Number(hours) || 0;
  h = ((h % 24) + 24) % 24;
  let hh = Math.floor(h);
  let mm = Math.floor((h - hh) * 60 + 1e-6);
  if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  return pad2(hh) + ':' + pad2(mm);
}

/** Seconds -> 'm:ss' (or 'h:mm:ss'); under 10 s shows tenths when `tenths` is set. */
export function formatTimer(sec, tenths = false) {
  sec = Math.max(0, Number(sec) || 0);
  if (tenths && sec < 10) return '0:0' + sec.toFixed(1);
  const t = Math.ceil(sec - 1e-6);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
}

/** Escape text for innerHTML. */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Keys recognised after "Press"/"Hold"/"Tap" in plain prompts (so 'Press F to enter Taxi' gets a key cap).
const KEY_WORDS = 'Space|Shift|Ctrl|Esc|Escape|Enter|Tab|LMB|RMB|MMB|Alt|Wheel|Mouse|[A-Z0-9]';
const AUTO_KEY = new RegExp('\\b(Press|press|Hold|hold|Tap|tap|Use|use)\\s+(' + KEY_WORDS + ')(?=\\b|\\s|$)', 'g');
// Explicit key caps: [F], [Space], [LMB], [Shift+W]. 1-12 chars, no nested brackets.
const BRACKET_KEY = /\[([A-Za-z0-9+\-/ ]{1,12})\]/g;
// Highlight: *word* -> accent colour (GTA '~y~' style). Also accepts ~y~text~s~ (yellow), ~g~ (green), ~r~ (red), ~b~ (blue).
const STAR_HL = /\*([^*\n]{1,60})\*/g;
const TILDE_HL = /~([ygrbpo])~([^~]{0,80})(?:~s~)?/g;

/**
 * Turn a plain HUD string into safe HTML with key caps and colour highlights.
 * 'Press F to enter *Taxi*' -> 'Press <kbd class="bc-key">F</kbd> to enter <b class="hl-y">Taxi</b>'.
 */
export function richText(text) {
  let s = escapeHtml(text);
  s = s.replace(BRACKET_KEY, (m, k) => '<kbd class="bc-key">' + k.trim() + '</kbd>');
  s = s.replace(AUTO_KEY, (m, verb, k) => verb + ' <kbd class="bc-key">' + k + '</kbd>');
  s = s.replace(STAR_HL, (m, t) => '<b class="hl-y">' + t + '</b>');
  s = s.replace(TILDE_HL, (m, c, t) => '<b class="hl-' + c + '">' + t + '</b>');
  return s;
}

/** km/h from a signed speed in m/s. */
export const toKmh = (ms) => Math.round(Math.abs(Number(ms) || 0) * 3.6);

/** Linear blend of two '#rrggbb' colours. */
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
  const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
  const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/** 0xRRGGBB -> '#rrggbb'. */
export const hexColor = (n) => '#' + ((1 << 24) | (n & 0xffffff)).toString(16).slice(1);

/** Title-case a district / poi type: 'gunshop' -> 'Gunshop'. */
export const titleCase = (s) => String(s || '').replace(/(^|[\s_-])(\w)/g, (m, sep, c) => (sep === '_' || sep === '-' ? ' ' : sep) + c.toUpperCase());

/** Compass heading name for a yaw (0 = +Z = South on the map, -Z = North). */
export function headingName(yaw) {
  // forward = (sin yaw, cos yaw) on (x, z); north = -Z. Bearing clockwise from north: atan2(x, -z).
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  let b = Math.atan2(fx, -fz) * 180 / Math.PI; // 0 = north, 90 = east (+X)
  b = (b + 360) % 360;
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(b / 45) % 8];
}
