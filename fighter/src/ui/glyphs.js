// Button glyphs that follow input.padType: Xbox (A/B/X/Y), PlayStation (cross/circle/square/triangle) or keyboard
// keys when padType is null. Glyphs are small CSS/SVG spans. Elements carrying data-glyph="<action>" are refreshed
// in place with refreshGlyphs(root, padType) whenever the device changes.
import { BINDINGS } from '../core/input.js';

const XBOX = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'up', 'down', 'left', 'right'];
const PS = ['cross', 'circle', 'square', 'triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'up', 'down', 'left', 'right'];
const XCOL = { A: '#86c97e', B: '#e6766a', X: '#6aa6e3', Y: '#e8c862' };
const PCOL = { cross: '#93b6ee', circle: '#ee8a92', square: '#e09ad3', triangle: '#6fd3b5' };

const PS_SHAPE = {
  cross: '<path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  circle: '<circle cx="12" cy="12" r="5.6" stroke="currentColor" stroke-width="2.2" fill="none"/>',
  square: '<rect x="7" y="7" width="10" height="10" stroke="currentColor" stroke-width="2.2" fill="none"/>',
  triangle: '<path d="M12 6.3l6 10.2H6z" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round" fill="none"/>',
};

const KEY_LABEL = {
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', Tab: 'Tab', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** Pretty key-cap label for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (KEY_LABEL[code]) return KEY_LABEL[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

function mouseSvg(btn) {
  const l = btn === 0 ? 'hl' : '', r = btn === 2 ? 'hl' : '';
  return '<span class="ls-g ls-g-mouse"><svg viewBox="0 0 24 24">' +
    `<path class="${l}" d="M12 3.6 a5.6 5.6 0 0 0 -5.6 5.6 V10.6 H12z" fill="${l ? '' : 'none'}"/>` +
    `<path class="${r}" d="M12 3.6 a5.6 5.6 0 0 1 5.6 5.6 V10.6 H12z" fill="${r ? '' : 'none'}"/>` +
    '<rect x="6.4" y="3.6" width="11.2" height="17" rx="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M12 3.6v7M6.4 10.6h11.2" stroke="currentColor" stroke-width="1.2"/></svg></span>';
}

/** Key cap (or mouse) glyph for a code. */
export function keyCap(code) {
  if (code === 'Mouse0') return mouseSvg(0);
  if (code === 'Mouse2') return mouseSvg(2);
  const t = keyLabel(code);
  return `<span class="ls-g ls-g-key${t.length > 2 ? ' wide' : ''}">${t}</span>`;
}

function dpad(dir) {
  const arm = (d, path) => `<path d="${path}" fill="${d === dir ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`;
  return '<span class="ls-g ls-g-dpad"><svg viewBox="0 0 24 24">' +
    arm('up', 'M9.5 3h5v6.5L12 12 9.5 9.5z') + arm('down', 'M9.5 21h5v-6.5L12 12l-2.5 2.5z') +
    arm('left', 'M3 9.5v5h6.5L12 12 9.5 9.5z') + arm('right', 'M21 9.5v5h-6.5L12 12l2.5-2.5z') + '</svg></span>';
}

function stick(label, pressed) {
  return `<span class="ls-g ls-g-stick${pressed ? ' click' : ''}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    `<circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".7"/></svg><b>${label}</b></span>`;
}

/** Glyph for a standard-mapping gamepad button index. */
export function padButton(index, padType) {
  const ps = padType === 'ps';
  const name = (ps ? PS : XBOX)[index];
  if (name === undefined) return '';
  if (index <= 3) {
    if (ps) return `<span class="ls-g ls-g-face" style="color:${PCOL[name]}"><svg viewBox="0 0 24 24">${PS_SHAPE[name]}</svg></span>`;
    return `<span class="ls-g ls-g-face" style="color:${XCOL[name]}"><b>${name}</b></span>`;
  }
  if (index >= 12) return dpad(name);
  if (index === 10 || index === 11) return stick(ps ? (index === 10 ? 'L3' : 'R3') : (index === 10 ? 'LS' : 'RS'), true);
  if (index === 8 || index === 9) {
    if (ps) return `<span class="ls-g ls-g-pill small">${name}</span>`;
    const icon = index === 8
      ? '<svg viewBox="0 0 24 24"><rect x="5" y="6" width="9" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="10" width="9" height="8" rx="1" fill="currentColor" opacity=".8"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 8h12M6 12h12M6 16h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    return `<span class="ls-g ls-g-face menu">${icon}</span>`;
  }
  return `<span class="ls-g ls-g-pill">${name}</span>`;
}

/** Keyboard binding glyph(s) used for an action when no pad is active. */
const KEY_PREF = {
  light: 'Mouse0', heavy: 'Mouse2', guard: 'ShiftLeft', dodge: 'Space', defend: 'KeyE', lock: 'KeyQ', stance: 'KeyR',
  focus: 'KeyF', target: 'KeyT', pause: 'Escape', deck: 'KeyI', confirm: 'Enter', back: 'Escape',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', tabPrev: 'KeyQ', tabNext: 'KeyE',
};

/**
 * Glyph HTML for an action (BINDINGS name, or a composite: 'move', 'camera', 'stanceFlick', 'navigate', 'menuX', 'menuY').
 * padType: 'xbox' | 'ps' | 'generic' | null (keyboard).
 */
export function glyph(action, padType) {
  const pad = !!padType;
  switch (action) {
    case 'move': return pad ? stick('L', false) : `${keyCap('KeyW')}${keyCap('KeyA')}${keyCap('KeyS')}${keyCap('KeyD')}`;
    case 'camera': return pad ? stick('R', false) : '<span class="ls-g ls-g-key wide">Mouse</span>';
    case 'stanceFlick': return pad ? `${padButton(7, padType)}<span class="ls-plus">+</span>${stick('R', false)}`
      : `${keyCap('KeyR')}<span class="ls-plus">+</span>${keyCap('KeyW')}<span class="ls-or">/</span>${keyCap('Digit1')}<span class="ls-or">–</span>${keyCap('Digit4')}`;
    case 'navigate': return pad ? dpad('') : `${keyCap('ArrowUp')}${keyCap('ArrowDown')}`;
    case 'menuX': return pad ? padButton(2, padType) : keyCap('KeyX');
    case 'menuY': return pad ? padButton(3, padType) : keyCap('KeyY');
    default: break;
  }
  const b = BINDINGS[action];
  if (!b) return '';
  if (pad) return b.pad.length ? padButton(b.pad[0], padType) : '';
  const code = KEY_PREF[action] || b.keys[0];
  return code ? keyCap(code) : '';
}

/** All keyboard keys bound to an action (for the controls screen). */
export function keyList(action) {
  const b = BINDINGS[action];
  if (!b) return '';
  const seen = new Set();
  return b.keys.filter((k) => { const l = keyLabel(k); if (seen.has(l)) return false; seen.add(l); return true; })
    .map(keyCap).join('<span class="ls-or">/</span>');
}

/** Refresh every [data-glyph] element under root for padType. */
export function refreshGlyphs(root, padType) {
  if (!root) return;
  const els = root.querySelectorAll('[data-glyph]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const html = glyph(el.dataset.glyph, padType);
    if (el.__g !== html) { el.__g = html; el.innerHTML = html; }
  }
}

/** Inline placeholder that refreshGlyphs fills. */
export const G = (action) => `<span class="ls-gw" data-glyph="${action}"></span>`;

/** Hint bar entry: glyph + label. */
export const hint = (action, label) => `<span class="ls-hint">${G(action)}<span>${label}</span></span>`;
