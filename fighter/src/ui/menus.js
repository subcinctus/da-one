// Menus (system game.menus): a stack of controller-first screens + the dialogue overlay.
//   D-pad / left stick / arrows move focus, A (Enter) confirms, B (Esc) goes back, LB / RB switch tabs; mouse works too.
//   Glyphs follow input.padType. Start opens the pause menu during play.
// Public API (used by Flow): showTitle(), card(opts) -> Promise, chooseStyle() -> Promise<styleId|null>,
//   confirm(msg, sub, yes, no) -> Promise<bool>, openDeck(opts) -> Promise, openPause(), openSettings(), openControls(),
//   openCredits(), closeAll(), dialogue (Dialogue), hudHidden(), isOpen(id), top().
import { injectCSS } from './style.js';
import { h, uiRoot } from './dom.js';
import { DirReader } from './nav.js';
import { BINDINGS } from '../core/input.js';
import { Dialogue } from './dialogue.js';
import { CardScreen } from './cards.js';
import { DeckScreen } from './deck.js';
import { TitleScreen, ConfirmScreen, StyleSelectScreen, PauseScreen, CreditsScreen } from './screens-main.js';
import { SettingsScreen, ControlsScreen } from './screens-options.js';

const ANY = Object.keys(BINDINGS);
/** Screen actions [name, input binding], in priority order. */
const ACTIONS = [['confirm', 'confirm'], ['back', 'back'], ['pause', 'pause'], ['deck', 'deck'], ['tabPrev', 'tabPrev'],
  ['tabNext', 'tabNext'], ['x', 'light'], ['y', 'heavy']];

export class Menus {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.stack = [];
    this.layer = null;
    this.dialogue = null;
    this.preview = null;          // MovePreview, shared by deck editor instances
    this.anyPressed = false;      // any button / key / click this frame (title screen)
    this._skip = 0;
    this._keys = new Set();
    this._click = false;
    this._pad = undefined;
    /** performance.now() of the last stack / menu change (click guard). */
    this.changedAt = 0;
  }

  init() {
    injectCSS();
    const g = this.game;
    this.layer = h('div', 'ls-layer ls-screens');
    uiRoot().appendChild(this.layer);
    this.dirs = new DirReader(g);
    this.dialogue = new Dialogue(this);
    window.addEventListener('keydown', (e) => { if (!e.repeat) this._keys.add(e.code); });
    window.addEventListener('mousedown', () => { this._click = true; });
    const ev = g.events;
    ev.on('dialogue', (e) => this.dialogue.push(e));
    ev.on('bossIntro', () => this.dialogue.markIntro());
    // a controller unplugged mid-fight pauses (console etiquette)
    ev.on('gamepad', (e) => { if (e && e.connected === false && this._canPause()) this.openPause(); });
    // mouse players: losing pointer lock (Esc in the browser) pauses rather than leaving the fight running
    ev.on('pointerLockChange', (e) => {
      if (e && e.locked === false && !g.input.padType && !g.uiOpen && this._canPause()) this.openPause();
    });
  }

  _canPause() {
    const g = this.game;
    return g.state === 'playing' && !g.paused && this.stack.length === 0 && !(g.flow && g.flow.busy);
  }

  // ---------------------------------------------------------------------------------------------- stack

  /** Push a screen (returns it). */
  push(screen) {
    this.stack.push(screen);
    this.changedAt = performance.now();
    screen.mount(this.layer);
    this._layerVisibility();
    if (screen.uiId) this.game.openUI(screen.uiId);
    this._skip = 1;
    this.dirs.reset();
    this._padRefresh(true);
    return screen;
  }

  /** Remove a screen from the stack. */
  remove(screen) {
    const i = this.stack.indexOf(screen);
    if (i < 0) return;
    this.stack.splice(i, 1);
    this.changedAt = performance.now();
    screen.unmount();
    this._layerVisibility();
    if (screen.uiId && !this.stack.some((s) => s.uiId === screen.uiId)) this.game.closeUI(screen.uiId);
    this._skip = 1;
    this.dirs.reset();
    const t = this.top();
    if (t && typeof t.refreshMenu === 'function') t.refreshMenu();
  }

  /** Screens under the topmost opaque one are hidden (visibility only: their state is kept). */
  _layerVisibility() {
    let covered = false;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const s = this.stack[i];
      if (s.el) s.el.style.visibility = covered ? 'hidden' : '';
      if (s.opaque) covered = true;
    }
  }

  /** Top screen or null. */
  top() { return this.stack.length ? this.stack[this.stack.length - 1] : null; }

  /** True when a screen with this id is open. */
  isOpen(id) { return this.stack.some((s) => s.id === id); }

  /** Close every screen (resolving their promises with null) and the dialogue. */
  closeAll() {
    for (let i = this.stack.length - 1; i >= 0; i--) this.stack[i].close(null);
    if (this.dialogue) this.dialogue.clear();
  }

  /** True while an opaque screen (card, deck editor, menu page) covers the game view. */
  covered() { for (const s of this.stack) if (s.opaque) return true; return false; }

  /** The HUD hides under opaque screens and blocking dialogue. */
  hudHidden() {
    for (const s of this.stack) if (s.hidesHud) return true;
    return !!(this.dialogue && this.dialogue.blocking);
  }

  // ---------------------------------------------------------------------------------------------- API

  /** Title screen ('Press any button' -> main menu). */
  showTitle() {
    this.closeAll();
    this.push(new TitleScreen(this));
  }

  /** Show a card; resolves when dismissed. See CardScreen for kinds. */
  card(opts) { return this.push(new CardScreen(this, opts)).promise; }

  /** Style select; resolves to a style id or null. */
  chooseStyle() { return this.push(new StyleSelectScreen(this)).promise; }

  /** Yes / no dialog; resolves to a boolean. */
  confirm(msg, sub, yes, no) { return this.push(new ConfirmScreen(this, msg, sub, yes, no)).promise.then((v) => !!v); }

  /** Deck editor; resolves when closed. opts: { tab: 'deck' | 'flow', atRest } */
  openDeck(opts = {}) {
    const open = this.stack.find((s) => s.id === 'deck');
    if (open) return open.promise;
    return this.push(new DeckScreen(this, opts)).promise;
  }

  /** Pause menu (also pauses the game). */
  openPause() {
    const g = this.game;
    if (this.isOpen('pause') || g.state !== 'playing') return;
    g.setPaused(true);
    try { g.input.exitLock(); } catch (e) { /* ignore */ }
    this.push(new PauseScreen(this));
  }

  openSettings() { return this.push(new SettingsScreen(this)).promise; }
  openControls() { return this.push(new ControlsScreen(this)).promise; }
  openCredits() { return this.push(new CreditsScreen(this)).promise; }

  // ---------------------------------------------------------------------------------------------- frame

  _padRefresh(force = false) {
    const pad = this.game.input ? this.game.input.padType : null;
    if (!force && pad === this._pad) return;
    this._pad = pad;
    for (const s of this.stack) s.refreshGlyphs();
  }

  update(dt) {
    const g = this.game, inp = g.input;
    this._padRefresh();
    const keyX = this._keys.has('KeyX'), keyY = this._keys.has('KeyY');
    let any = this._click || this._keys.size > 0;
    if (!any && inp) for (let i = 0; i < ANY.length; i++) if (inp.pressed(ANY[i], true)) { any = true; break; }
    this.anyPressed = any;
    if (this._keys.size) this._keys.clear();
    this._click = false;

    if (this._skip > 0) this._skip--;
    else if (inp && this._canPause() && inp.pressed('pause', true)) this.openPause();
    else if (inp) {
      const top = this.top();
      if (top) {
        const d = this.dirs.poll(dt);
        if (d) top.onDir(d);
        // one action per frame, in priority order; stop when the stack changed
        for (let i = 0; i < ACTIONS.length && this.top() === top && !this._skip; i++) {
          const [name, bind] = ACTIONS[i];
          if (inp.pressed(bind, true) || (name === 'x' && keyX) || (name === 'y' && keyY)) { top.onAction(name); break; }
        }
      } else if (this.dialogue.blocking && this.dialogue.cur) {
        this.dirs.poll(dt);
        if (inp.pressed('confirm', true) || inp.pressed('light', true)) this.dialogue.advance();
        else if (inp.pressed('back', true)) this.dialogue.skipAll();
      }
    }
    for (let i = 0; i < this.stack.length; i++) {
      const s = this.stack[i];
      try { s.update(dt); } catch (e) { if (!s.__err) { s.__err = true; console.error('[ui] screen update', s.id, e); } }
    }
    this.dialogue.update(dt);
  }
}
