// Base class for modal UI screens (title, menus, cards, deck editor). The Menus system owns a stack of them; the top
// screen receives controller input. A screen with `uiId` calls game.openUI(uiId) while mounted (freezes the sim and
// blocks gameplay input); `hidesHud` hides the HUD.
import { h } from './dom.js';
import { Nav } from './nav.js';
import { refreshGlyphs } from './glyphs.js';

export class Screen {
  /** @param menus the Menus system; o: { id, uiId (null = none), hidesHud } */
  constructor(menus, o = {}) {
    this.menus = menus;
    this.game = menus.game;
    this.id = o.id || 'screen';
    this.uiId = o.uiId === undefined ? this.id : o.uiId;
    this.hidesHud = o.hidesHud !== undefined ? !!o.hidesHud : true;
    /** Opaque screens hide the screens below them (no bleed-through of a dimmed title or menu). */
    this.opaque = o.opaque !== undefined ? !!o.opaque : true;
    this.el = null;
    this.nav = new Nav(this.game);
    this.closed = false;
    this.promise = new Promise((r) => { this._resolve = r; });
  }

  /** Build and return the root element (override). */
  render() { return h('div', 'ls-screen'); }

  /** Element to focus first (override). */
  initialFocus() { return null; }

  mount(layer) {
    this.el = this.render();
    this.nav.root = this.el;
    layer.appendChild(this.el);
    this.el.addEventListener('mousemove', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
      if (t && this.el.contains(t) && t !== this.nav.current) this.nav.focus(t);
    });
    this.el.addEventListener('click', (e) => {
      // a click whose press opened / changed this screen must not also activate what appeared under the cursor
      if (performance.now() - this.menus.changedAt < 180) return;
      const t = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
      if (t && this.el.contains(t)) { this.nav.focus(t, true); this.nav.activate(); return; }
      const a = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (a && this.el.contains(a)) { this.onAction(a.dataset.action); return; }
      if (typeof this.onBackgroundClick === 'function') this.onBackgroundClick(e);
    });
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onAction('back'); });
    this.refreshGlyphs();
    if (typeof this.onMount === 'function') this.onMount();
    if (!this.nav.current) this.nav.focus(this.initialFocus(), true);
  }

  /** Re-render glyph placeholders for the active device. */
  refreshGlyphs() { if (this.el) refreshGlyphs(this.el, this.game.input ? this.game.input.padType : null); }

  /**
   * Input from Menus. a: 'confirm' | 'back' | 'tabPrev' | 'tabNext' | 'x' | 'y' | 'pause' | 'deck'.
   * Return true when handled.
   */
  onAction(a) {
    if (a === 'confirm') return this.nav.activate();
    if (a === 'back') { this.back(); return true; }
    return false;
  }

  /** D-pad / stick direction. Left/right adjust a focused slider first. */
  onDir(d) {
    if ((d === 'left' || d === 'right') && this.nav.adjust(d === 'left' ? -1 : 1)) return true;
    return this.nav.move(d);
  }

  /** Back / B (override; default does nothing). */
  back() {}

  /** Per-frame (real time). */
  update(dt) {}

  /** Close this screen and resolve its promise with `value`. */
  close(value) {
    if (this.closed) return;
    this.closed = true;
    this.menus.remove(this);
    this._resolve(value);
  }

  unmount() {
    const el = this.el;
    if (typeof this.onUnmount === 'function') { try { this.onUnmount(); } catch (e) { console.error('[ui] unmount', e); } }
    if (!el) return;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 230);
  }
}
