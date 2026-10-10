// Menus (see ARCHITECTURE.md §Menus): the title screen over the live orbiting scene (Play, or Continue + New Game
// when a save exists, Settings, Controls), the pause menu (Esc / P or losing pointer lock: Resume, Map, Settings,
// Controls, Save Game, Creative toggle, New Game + a status card), and the pointer-lock fallback hint.
import { el, injectStyles, uiRoot } from './styles.js';
import { createLogoCanvas } from './logo.js';
import { buildSettingsPage, buildControlsPage } from './menu_pages.js';
import { STAR_SVG } from './icons.js';
import { formatMoney, formatClock } from './format.js';

const SPLASHES = [
  'Now with cops!', 'Five stars!', '100% blocks!', 'Also try mining!', 'Pay \'n\' Spray!', 'TNT included!',
  'Diamonds = $$$', 'Wasted!', 'Steal responsibly!', 'Voxel crime!', 'No assets!', 'Drift!', 'Carjack simulator!',
];

export class Menus {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** 'title' | 'pause' | 'settings' | 'controls' | null */
    this.screen = null;
    this.root = null;
    this._back = null;
    this._statsT = 0;
    this._lockHinted = false;
    this._inited = false;
  }

  init() {
    injectStyles();
    const g = this.game;
    const ev = g.events;
    ev.on('pointerLockChange', (e) => {
      if (!e) return;
      if (!e.locked) {
        // lost pointer lock while playing (Esc, alt-tab) -> pause menu
        if (g.state === 'playing' && !g.paused && !g.uiOpen && !g.input?.lockFailed) g.setPaused(true);
      } else if (g.paused || g.uiOpen || g.state !== 'playing') {
        // a lock granted late (e.g. after closing a panel from the pause menu) must not hide the cursor in menus
        g.input?.exitLock?.();
      }
    });
    ev.on('pauseChanged', (e) => {
      if (g.state !== 'playing') return;
      if (e && e.paused) { if (!g.hud?.layerOpen) this.showPause(); } else this._close();
    });
    ev.on('gameStart', () => {
      if (this.screen === 'title' || this._back === 'title') this._close();
      this._back = null;
    });
    if (g.debug) {
      g.debug.menus = this;
      g.debug.pause = (p = true) => { if (g.state === 'playing') g.setPaused(!!p); return g.paused; };
    }
    this._inited = true;
  }

  // ================================================================== title

  /** Animated title screen over the live scene (the camera rig orbits while state === 'title'). */
  showTitle() {
    injectStyles();
    const g = this.game;
    try { g.input?.exitLock?.(); } catch (e) { /* ignore */ }
    const m = this._mount('title');
    const box = el('div', 'bc-logo-box', m);
    this._logoBox = box;
    let logo = null;
    try {
      logo = createLogoCanvas(logoWidth());
      box.appendChild(logo);
    } catch (e) {
      el('h1', '', box, 'BLOCK CITY').style.cssText = 'font:400 72px var(--font-display);margin:0;letter-spacing:.06em';
    }
    const sp = el('div', 'splash', box, SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
    sp.style.right = '-4%';
    sp.style.bottom = '8%';
    const tag = el('div', 'tag', m);
    tag.innerHTML = 'Build. Mine. Drive. Steal. <b>Survive the cops.</b>';
    const btns = el('div', 'btns', m);
    const hasSave = !!(g.save && typeof g.save.hasSave === 'function' && safe(() => g.save.hasSave()));
    if (hasSave) {
      this._btn(btns, 'Continue', 'primary', () => this._play());
      this._btn(btns, 'New Game', 'danger', () => this._newGame());
    } else {
      this._btn(btns, 'Play', 'primary', () => this._play());
    }
    const row = el('div', 'row', btns);
    this._btn(row, 'Settings', '', () => this._page('settings', 'title'));
    this._btn(row, 'Controls', '', () => this._page('controls', 'title'));
    const foot = el('div', 'foot', m);
    const touch = !!g.hud?.touchMode;
    foot.textContent = (touch ? 'Left stick to move · drag to look · ATK to shoot & mine' :
      'WASD move · Mouse look · F steal a car · E inventory · M map · Esc pause') + '   ·   seed ' + (g.seed ?? '');
    this._fitTitle();
    setTimeout(() => { try { btns.querySelector('.bc-btn')?.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 50);
  }

  /**
   * Short windows (embeds, previews, 800x450...): shrink the logo until the title column (logo, tagline, buttons and
   * the footer) fits the height, so nothing is clipped or overlapped. One layout read; runs on show and on resize.
   */
  _fitTitle() {
    const m = this.root, box = this._logoBox;
    const logo = box && box.querySelector('canvas.bc-logo');
    this._fitSize = [window.innerWidth, window.innerHeight];
    if (!m || !logo || !logo.height) return;
    try {
      const cs = getComputedStyle(m);
      const avail = m.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      let top = Infinity, bottom = -Infinity, foot = 0;
      for (const c of m.children) {
        const st = getComputedStyle(c);
        if (st.display === 'none') continue;
        if (st.position === 'absolute') { if (c.classList.contains('foot')) foot = c.offsetHeight + 18; continue; }
        top = Math.min(top, c.offsetTop);
        bottom = Math.max(bottom, c.offsetTop + c.offsetHeight);
      }
      const over = bottom - top + foot - avail;
      if (!(over > 0)) return;
      const h = Math.max(56, logo.offsetHeight - over - 6);
      const w = Math.floor(h * logo.width / logo.height);
      const fit = createLogoCanvas(w);
      fit.style.animation = logo.style.animation;
      logo.replaceWith(fit);
    } catch (e) { /* layout unavailable: keep the default size */ }
  }

  /** Window resized while the title is up: rebuild the logo at the size that fits the new window. */
  onResize(w, h) {
    if (this.screen !== 'title' || !this._logoBox) return;
    const f = this._fitSize;
    if (f && Math.abs(f[0] - (w || window.innerWidth)) < 8 && Math.abs(f[1] - (h || window.innerHeight)) < 8) return;
    const old = this._logoBox.querySelector('canvas.bc-logo');
    if (!old) return;
    try {
      const logo = createLogoCanvas(logoWidth());
      logo.style.animation = 'none'; // no drop-in replay while resizing
      old.replaceWith(logo);
      this._fitTitle();
    } catch (e) { /* keep the old logo */ }
  }

  _play() {
    const g = this.game;
    this._close();
    g.startPlaying();
    g.audio?.play?.('ui_click');
    if (g.input?.lockFailed && !this._lockHinted) this._hintLock();
  }

  async _newGame() {
    const g = this.game;
    const ok = await (g.hud?.confirm ? g.hud.confirm('New game?', 'Your saved progress (money, inventory, buildings, missions) will be deleted.', { ok: 'Start over', danger: true })
      : Promise.resolve(window.confirm('Start a new game? Your saved progress will be lost.')));
    if (!ok) return;
    try { g.save?.clear?.(); } catch (e) { console.error('[menus] save.clear', e); }
    try { location.reload(); } catch (e) { /* ignore */ }
  }

  // ================================================================== pause

  showPause() {
    const g = this.game;
    if (g.state !== 'playing') return;
    const m = this._mount('pause');
    const left = el('div', 'bc-pause-l', m);
    const h = el('h1', '', left, 'PAUSED');
    el('small', '', h, 'BLOCK CITY');
    const btns = el('div', 'btns', left);
    btns.style.width = '100%';
    this._btn(btns, 'Resume', 'primary', () => this.resume(), 'Esc');
    this._btn(btns, 'Map', '', () => { this._close(); g.hud?.fullMap?.open?.(); }, 'M');
    const row = el('div', 'row', btns);
    this._btn(row, 'Settings', '', () => this._page('settings', 'pause'));
    this._btn(row, 'Controls', '', () => this._page('controls', 'pause'));
    const saveBtn = this._btn(btns, 'Save Game', '', () => {
      let ok = false;
      try { ok = g.save && typeof g.save.save === 'function' ? g.save.save() !== false : false; } catch (e) { console.error('[menus] save', e); ok = false; }
      saveBtn.firstChild.textContent = ok ? 'Game saved ✓' : 'Saving unavailable';
      g.hud?.notify?.(ok ? 'Game saved.' : 'Saving is unavailable.', { duration: 2.5, color: ok ? '#46c46f' : '#e5484d' });
      g.audio?.play?.(ok ? 'checkpoint' : 'error', { volume: 0.6 });
      setTimeout(() => { if (saveBtn.isConnected) saveBtn.firstChild.textContent = 'Save Game'; }, 1600);
    });
    if (!g.save || typeof g.save.save !== 'function') saveBtn.disabled = true;
    const inv = g.inventory;
    const creativeLabel = () => 'Creative mode: ' + (inv && inv.creative ? 'ON' : 'OFF');
    const cBtn = this._btn(btns, creativeLabel(), '', () => {
      if (!inv) return;
      const on = !inv.creative;
      if (typeof inv.setCreative === 'function') inv.setCreative(on); else inv.creative = on;
      cBtn.firstChild.textContent = creativeLabel();
      g.hud?.notify?.(on ? 'Creative mode *ON*: unlimited blocks, double-tap [Space] to fly.' : 'Creative mode OFF.', { duration: 3 });
    });
    if (!inv) cBtn.disabled = true;
    this._btn(btns, 'New Game', 'danger', () => this._newGame());

    const right = el('div', 'bc-pause-r', m);
    const card = el('div', 'bc-card', right);
    el('h4', '', card, 'Status');
    this._kv = el('div', 'bc-kv', card);
    this._statsT = 0;
    this._refreshStats();
    if (g.input?.lockFailed || g.hud?.touchMode) {
      const hint = el('div', 'bc-lockhint', right);
      hint.textContent = g.hud?.touchMode
        ? 'Touch controls: left stick moves, drag on the right half to look around.'
        : 'Mouse capture is unavailable here: moving the mouse over the game turns the camera.';
    }
  }

  _refreshStats() {
    const g = this.game;
    if (!this._kv) return;
    const p = g.player;
    const rows = [];
    rows.push(['Cash', '<span class="v money">' + formatMoney(p?.money || 0) + '</span>', true]);
    rows.push(['Health', Math.round(p?.health ?? 0) + ' / ' + (p?.maxHealth || 100)]);
    rows.push(['Armor', Math.round(p?.armor ?? 0)]);
    const w = (g.police?.wanted) | 0;
    rows.push(['Wanted', '<span class="stars">' + [0, 1, 2, 3, 4].map((i) => '<span class="bc-star' + (i < w ? ' on' : '') + '">' + STAR_SVG + '</span>').join('') + '</span>']);
    rows.push(['Time', g.sky ? formatClock(g.sky.time) : '--:--']);
    let area = '-';
    try { if (p && g.generator?.plan?.districtAt) area = g.generator.plan.districtAt(p.position.x, p.position.z)?.name || '-'; } catch (e) { area = '-'; }
    rows.push(['Area', area]);
    const done = g.missions?.completed;
    if (done && typeof done.size === 'number') rows.push(['Missions done', String(done.size)]);
    rows.push(['Mode', g.inventory?.creative ? 'Creative' : 'Survival']);
    const html = rows.map(([k, v, raw]) => '<span class="k">' + k + '</span>' + (raw ? v : '<span class="v">' + v + '</span>')).join('');
    if (html !== this._kvHtml) { this._kvHtml = html; this._kv.innerHTML = html; }
  }

  /** Resume from the pause menu. */
  resume() {
    const g = this.game;
    this._close();
    if (g.state === 'playing') g.setPaused(false);
    if (g.input?.lockFailed && !this._lockHinted) this._hintLock();
  }

  _hintLock() {
    this._lockHinted = true;
    if (this.game.hud?.touchMode) return;
    this.game.hud?.notify?.('Mouse capture is unavailable here: move the mouse over the game to turn the camera.', { duration: 6, color: '#f5c518' });
  }

  // ================================================================== sub pages

  _page(kind, back) {
    const g = this.game;
    const m = this._mount(kind, back);
    m.classList.add(back === 'title' ? 'title' : 'pause');
    const onBack = () => { if (back === 'title') this.showTitle(); else this.showPause(); };
    const page = kind === 'settings' ? buildSettingsPage(g, onBack) : buildControlsPage(g, onBack, !!g.hud?.touchMode);
    m.appendChild(page);
  }

  // ================================================================== plumbing

  _mount(screen, back = null) {
    this._close();
    const root = el('div', 'bc-menu ' + (screen === 'title' || screen === 'pause' ? screen : ''), uiRoot());
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root = root;
    this.screen = screen;
    this._back = back;
    return root;
  }

  _close() {
    if (this.root) { this.root.remove(); this.root = null; }
    this.screen = null;
    this._logoBox = null;
    this._kv = null;
    this._kvHtml = '';
  }

  _btn(parent, label, cls, fn, key) {
    const b = el('button', 'bc-btn' + (cls ? ' ' + cls : ''), parent);
    el('span', '', b, label);
    if (key && !this.game.hud?.touchMode) el('span', 'k', b, key);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      this.game.audio?.play?.('ui_click');
      fn();
    });
    return b;
  }

  update(dt) {
    if (!this._inited) return;
    const g = this.game;
    const input = g.input;
    if (!input) return;
    const hud = g.hud;
    if (input.pressed('pause', true)) {
      if (hud?.panels?.confirmOpen) hud.closeTop();
      else if (this.screen === 'settings' || this.screen === 'controls') {
        g.audio?.play?.('ui_click');
        if (this._back === 'title') this.showTitle(); else this.showPause();
      } else if (g.state === 'playing') {
        if (hud?.layerOpen || g.uiOpen) hud?.closeTop?.();
        else if (g.paused) this.resume();
        else g.setPaused(true);
      }
    }
    if (g.state === 'playing' && g.paused) {
      // back from a layer opened from the pause menu (e.g. the map) -> show the pause menu again
      if (!this.screen && !hud?.layerOpen) this.showPause();
      if (this.screen === 'pause') {
        this._statsT -= dt;
        if (this._statsT <= 0) { this._statsT = 0.5; this._refreshStats(); }
      }
    }
    if (g.state === 'playing' && !g.paused && this.screen === 'pause') this._close();
  }
}

function safe(fn) { try { return fn(); } catch (e) { return false; } }

/** Preferred title logo CSS width (560 px max, 84% of the width); Menus._fitTitle shrinks it on short windows. */
function logoWidth() {
  return Math.max(160, Math.round(Math.min(560, (window.innerWidth || 1280) * 0.84)));
}
