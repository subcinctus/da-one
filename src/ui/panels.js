// Generic modal panels for other systems (shops, mission log, ...): hud.openPanel(title, element, {onClose, width})
// opens game.openUI('panel') and a styled window; closing calls onClose. Panels stack; Esc closes the top one.
// Also a promise-based confirm dialog used by the menus.
import { el } from './styles.js';

export class PanelStack {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.stack = [];
    this._lastOpen = { id: null, frame: -99 };
    this.confirmOpen = null;
  }

  /** Track UI ids opened by other systems (e.g. 'shop' opened right before openPanel) to close them with the panel. */
  onUiChanged(e) {
    if (e && e.open && e.id !== 'panel') this._lastOpen = { id: e.id, frame: this.game.frame | 0 };
  }

  get open() { return this.stack.length > 0; }

  /**
   * Open a modal panel. Returns {root, body, element, close(), setTitle(t)}.
   * opts: {onClose, width (px or css), uiId (extra UI id to close with the panel)}.
   */
  openPanel(title, element, opts = {}) {
    const g = this.game;
    const layer = el('div', 'bc-layer', this.hud.layerRoot);
    const panel = el('div', 'bc-panel', layer);
    if (opts.width) panel.style.setProperty('--w', typeof opts.width === 'number' ? opts.width + 'px' : String(opts.width));
    const header = el('header', '', panel);
    const h2 = el('h2', '', header, title == null ? '' : String(title));
    const x = el('button', 'bc-x', header, '✕');
    x.title = 'Close (Esc)';
    const body = el('div', 'body', panel);
    if (element instanceof Node) body.appendChild(element);
    else if (typeof element === 'string') body.innerHTML = element;
    // a UI id opened by the caller in the same frame (e.g. 'shop') belongs to this panel
    let companion = opts.uiId || null;
    if (!companion && this._lastOpen.id && (g.frame | 0) - this._lastOpen.frame <= 1 && g.isUIOpen?.(this._lastOpen.id)) companion = this._lastOpen.id;
    const rec = {
      root: layer, panel, body, element, title, onClose: opts.onClose, companion, closed: false,
      close: () => this._close(rec),
      setTitle: (t) => { h2.textContent = String(t); },
    };
    x.addEventListener('click', (e) => { e.stopPropagation(); g.audio?.play?.('ui_click'); rec.close(); });
    // stop clicks inside panels from reaching the game canvas
    layer.addEventListener('mousedown', (e) => e.stopPropagation());
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    this.stack.push(rec);
    if (!g.isUIOpen?.('panel')) g.openUI('panel');
    g.audio?.play?.('ui_open');
    return rec;
  }

  _close(rec) {
    if (!rec || rec.closed) return;
    rec.closed = true;
    const i = this.stack.indexOf(rec);
    if (i >= 0) this.stack.splice(i, 1);
    rec.root.remove();
    const g = this.game;
    if (this.stack.length === 0) g.closeUI('panel');
    if (typeof rec.onClose === 'function') {
      try { rec.onClose(); } catch (e) { console.error('[hud] panel onClose', e); }
    }
    if (rec.companion && g.isUIOpen?.(rec.companion)) g.closeUI(rec.companion);
  }

  /** Close the top-most panel. Returns true if one was closed. */
  closeTop() {
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    top.close();
    return true;
  }

  closeAll() { while (this.stack.length) this.closeTop(); }

  /** Confirm dialog -> Promise<boolean>. opts: {ok, cancel, danger}. */
  confirm(title, text, opts = {}) {
    if (this.confirmOpen) this.confirmOpen.resolve(false);
    return new Promise((resolve) => {
      const layer = el('div', 'bc-layer', this.hud.layerRoot);
      layer.style.zIndex = '75';
      const box = el('div', 'bc-confirm', layer);
      el('h3', '', box, title);
      el('p', '', box, text);
      const row = el('div', 'row', box);
      const no = el('button', 'bc-btn', row, opts.cancel || 'Cancel');
      const yes = el('button', 'bc-btn ' + (opts.danger ? 'danger' : 'primary'), row, opts.ok || 'OK');
      const done = (v) => {
        if (!layer.isConnected) return;
        layer.remove();
        if (this.confirmOpen && this.confirmOpen.layer === layer) this.confirmOpen = null;
        this.game.audio?.play?.('ui_click');
        resolve(v);
      };
      no.addEventListener('click', () => done(false));
      yes.addEventListener('click', () => done(true));
      layer.addEventListener('mousedown', (e) => e.stopPropagation());
      this.confirmOpen = { layer, resolve: done };
      setTimeout(() => { try { no.focus(); } catch (e) { /* ignore */ } }, 0);
    });
  }

  /** Close an open confirm dialog (as "cancel"). */
  closeConfirm() {
    if (!this.confirmOpen) return false;
    this.confirmOpen.resolve(false);
    return true;
  }
}
