// Controller-first focus navigation for menu screens: D-pad / left stick / arrow keys move a focus highlight between
// [data-nav] elements by screen position (spatial navigation), with key-repeat. Mouse hover focuses, click activates.
//   el._act()          activation (A / Enter / click)
//   el._adjust(dir)    optional: left/right (-1/+1) changes a value instead of moving focus (sliders, toggles)
//   el._focus()        optional: called when focused
import { sfx } from './dom.js';

const DIRS = ['up', 'down', 'left', 'right'];
const REPEAT_DELAY = 0.36, REPEAT_RATE = 0.085;

/** Direction of the first connected gamepad's left stick ('up' | ... | null). Gameplay input zeroes sticks in UI. */
export function stickDir(threshold = 0.55) {
  let pads;
  try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
  if (!pads) return null;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected || !p.axes || p.axes.length < 2) continue;
    const x = p.axes[0] || 0, y = p.axes[1] || 0;
    if (Math.abs(x) < threshold && Math.abs(y) < threshold) continue;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
  }
  return null;
}

/** Shared direction reader with repeat (one per Menus). */
export class DirReader {
  constructor(game) { this.game = game; this.held = null; this.heldT = 0; this.repT = 0; }
  reset() { this.held = '__reset'; }
  /** Direction pressed (or auto-repeated) this frame. Taps shorter than a frame still count (input edges). */
  poll(dt) {
    const inp = this.game.input;
    let dir = null, edge = null;
    if (inp && typeof inp.down === 'function') {
      for (const d of DIRS) {
        if (!edge && inp.pressed(d, true)) edge = d;
        if (!dir && inp.down(d, true)) dir = d;
      }
    }
    if (!dir) dir = stickDir();
    if (edge) { this.held = dir || edge; this.heldT = 0; this.repT = 0; return edge; }
    if (this.held === '__reset') { this.held = dir; this.heldT = 0; return null; }   // ignore a direction held across screens
    if (dir !== this.held) { this.held = dir; this.heldT = 0; this.repT = 0; return dir; }
    if (!dir) return null;
    this.heldT += dt;
    if (this.heldT < REPEAT_DELAY) return null;
    this.repT -= dt;
    if (this.repT <= 0) { this.repT = REPEAT_RATE; return dir; }
    return null;
  }
}

/** Focus manager for one screen. */
export class Nav {
  constructor(game, root = null) {
    this.game = game;
    this.root = root;
    this.current = null;
    this.silent = false;
    /** Up/down wrap around at the ends of a column. */
    this.wrap = true;
  }

  /** Focusable elements (visible [data-nav]). */
  items() {
    if (!this.root) return [];
    const all = this.root.querySelectorAll('[data-nav]');
    const out = [];
    for (let i = 0; i < all.length; i++) if (all[i].offsetParent !== null || all[i].getClientRects().length) out.push(all[i]);
    return out;
  }

  /** Focus an element (or the first item). */
  focus(el, silent = false) {
    if (!el) el = this.items()[0] || null;
    if (!el || el === this.current) { if (el) this._scroll(el); return; }
    if (this.current) this.current.classList.remove('focus');
    this.current = el;
    el.classList.add('focus');
    this._scroll(el);
    if (typeof el._focus === 'function') { try { el._focus(); } catch (e) { console.error('[ui] focus handler', e); } }
    if (!silent) sfx(this.game, 'ui_move');
  }

  _scroll(el) {
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old browsers */ }
  }

  /** Keep focus valid after a re-render (same data-key if possible). */
  restore(fallback) {
    const key = this.current && this.current.dataset ? this.current.dataset.key : null;
    this.current = null;
    let el = null;
    if (key && this.root) el = this.root.querySelector(`[data-nav][data-key="${CSS && CSS.escape ? CSS.escape(key) : key}"]`);
    this.focus(el || fallback || null, true);
  }

  /** Move focus spatially. Returns true when focus changed. */
  move(dir) {
    const cur = this.current && this.current.isConnected ? this.current : null;
    const items = this.items();
    if (!items.length) return false;
    if (!cur) { this.focus(items[0]); return true; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let primary, ortho;
      if (dir === 'up') { primary = a.top - b.bottom; ortho = Math.abs(bx - ax); if (by >= ay - 1) continue; }
      else if (dir === 'down') { primary = b.top - a.bottom; ortho = Math.abs(bx - ax); if (by <= ay + 1) continue; }
      else if (dir === 'left') { primary = a.left - b.right; ortho = Math.abs(by - ay); if (bx >= ax - 1) continue; }
      else { primary = b.left - a.right; ortho = Math.abs(by - ay); if (bx <= ax + 1) continue; }
      const score = Math.max(0, primary) + ortho * 2.2 + (primary < -4 ? 40 : 0);
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best && this.wrap && (dir === 'up' || dir === 'down')) {
      // vertical lists wrap around: jump to the far end, staying in the same column
      let far = -Infinity;
      for (const el of items) {
        if (el === cur) continue;
        const b = el.getBoundingClientRect();
        const bx = b.left + b.width / 2, by = b.top + b.height / 2;
        if (Math.abs(bx - ax) > Math.max(a.width, b.width) / 2) continue;
        const k = dir === 'down' ? -by : by;
        if (k > far) { far = k; best = el; }
      }
    }
    if (best) { this.focus(best); return true; }
    return false;
  }

  /** Activate the focused element. */
  activate() {
    const el = this.current;
    if (!el || !el.isConnected || typeof el._act !== 'function') return false;
    if (el.classList.contains('disabled')) { sfx(this.game, 'ui_back'); return true; }
    sfx(this.game, 'ui_select');
    try { el._act(); } catch (e) { console.error('[ui] activate', e); }
    return true;
  }

  /** Left/right adjust on the focused element. Returns true when handled. */
  adjust(dir) {
    const el = this.current;
    if (!el || typeof el._adjust !== 'function') return false;
    try { el._adjust(dir); } catch (e) { console.error('[ui] adjust', e); }
    sfx(this.game, 'ui_move');
    return true;
  }
}
