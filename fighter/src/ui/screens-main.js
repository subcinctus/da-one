// Title, main menu, chapter select, style select, credits, confirm dialog and the pause menu.
import { Screen } from './screen.js';
import { h, esc, roman, sfx, stanceIcon } from './dom.js';
import { G, hint } from './glyphs.js';
import { CHAPTERS, GAME_TITLE } from '../data/chapters.js';
import { STYLES } from '../data/stances.js';
import { STYLE_COPY, CREDITS } from '../game/story.js';
import { unlockedChapters } from '../game/progress.js';
import { splitBossName, PAD_BLOCKED_TEXT } from './hud.js';

/** Jade seal: four stance diamonds in a square frame. */
export const SEAL = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="1.5" y="1.5" width="45" height="45" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <rect x="5" y="5" width="38" height="38" fill="none" stroke="currentColor" stroke-width=".8" opacity=".55"/>
  <g fill="currentColor"><rect x="12.5" y="12.5" width="8" height="8" transform="rotate(45 16.5 16.5)"/>
  <rect x="27.5" y="12.5" width="8" height="8" transform="rotate(45 31.5 16.5)" opacity=".45"/>
  <rect x="12.5" y="27.5" width="8" height="8" transform="rotate(45 16.5 31.5)" opacity=".45"/>
  <rect x="27.5" y="27.5" width="8" height="8" transform="rotate(45 31.5 31.5)" opacity=".45"/></g></svg>`;

/** Menu item element. */
function item(label, act, sub = '', key = label) {
  const el = h('div', 'ls-mi', `${esc(label)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`);
  el.dataset.nav = '';
  el.dataset.key = key;
  el._act = act;
  return el;
}

// ================================================================================================ title + main menu

export class TitleScreen extends Screen {
  constructor(menus) {
    super(menus, { id: 'title', uiId: null });
    this.phase = 'press';
    this._t = 0;
  }

  render() {
    const [a, b] = GAME_TITLE.split(' ');
    const el = h('div', 'ls-screen ls-title');
    el.innerHTML = `
      <div class="wrap">
        <div class="ls-seal">${SEAL}</div>
        <h1><span>${esc(a || GAME_TITLE)}</span>${b ? `<span>${esc(b)}</span>` : ''}</h1>
        <div class="tag"><i></i>A revenge in four stances</div>
        <div class="ls-press">${G('confirm')}<span>Press any button</span></div>
        <div class="ls-menu ls-hidden"></div>
      </div>
      <div class="ls-hintbar left ls-hidden">${hint('confirm', 'Select')}${hint('back', 'Back')}</div>
      <div class="ls-version">v1.0 · ${esc(this.game.input && this.game.input.padType ? 'Controller' : 'Keyboard & mouse')}</div>
      <div class="ls-padblocked ls-hidden">${esc(PAD_BLOCKED_TEXT.join(' '))}</div>`;
    this.$press = el.querySelector('.ls-press');
    this.$menu = el.querySelector('.ls-menu');
    this.$hints = el.querySelector('.ls-hintbar');
    this.$ver = el.querySelector('.ls-version');
    this.$padBlocked = el.querySelector('.ls-padblocked');
    return el;
  }

  _buildMenu() {
    const m = this.menus, fl = this.game.flow;
    const menu = this.$menu;
    menu.innerHTML = '';
    const canContinue = !!(fl && typeof fl.hasSave === 'function' && fl.hasSave());
    if (canContinue) {
      const p = fl.progress;
      const ch = CHAPTERS.find((c) => c.id === p.chapterId);
      menu.appendChild(item('Continue', () => fl.continueGame(), ch ? `Chapter ${roman(ch.index)} · ${ch.title} · Age ${p.age}` : ''));
    }
    menu.appendChild(item('New Game', () => this._newGame()));
    if (canContinue) menu.appendChild(item('Chapters', () => m.push(new ChapterSelectScreen(m))));
    menu.appendChild(item('Settings', () => m.openSettings()));
    menu.appendChild(item('Controls', () => m.openControls()));
    menu.appendChild(item('Credits', () => m.push(new CreditsScreen(m))));
  }

  async _newGame() {
    const fl = this.game.flow, m = this.menus;
    if (fl && typeof fl.hasSave === 'function' && fl.hasSave()) {
      const ok = await m.confirm('Begin a new life?', 'Your current progress, age and learned moves will be lost.', 'Begin again', 'Keep it');
      if (!ok) return;
    }
    const style = await m.chooseStyle();
    if (!style) return;
    if (fl && typeof fl.newGame === 'function') fl.newGame(style);
  }

  showMenu() {
    if (this.phase === 'menu') return;
    this.phase = 'menu';
    this.menus.changedAt = performance.now();
    this.$press.classList.add('ls-hidden');
    this.$menu.classList.remove('ls-hidden');
    this.$hints.classList.remove('ls-hidden');
    this._buildMenu();
    this.refreshGlyphs();
    this.nav.current = null;
    this.nav.focus(this.$menu.querySelector('[data-nav]'), true);
    sfx(this.game, 'ui_select');
    try { if (this.game.audio && typeof this.game.audio.unlock === 'function') this.game.audio.unlock(); } catch (e) { /* optional */ }
  }

  showPress() {
    this.phase = 'press';
    this._t = 0;   // the 0.4 s guard in update() swallows the B press that brought us back here
    this.$press.classList.remove('ls-hidden');
    this.$menu.classList.add('ls-hidden');
    this.$hints.classList.add('ls-hidden');
    sfx(this.game, 'ui_back');
  }

  /** Rebuild after returning from a sub screen (save may have changed). */
  refreshMenu() {
    if (this.phase !== 'menu') return;
    const key = this.nav.current && this.nav.current.dataset.key;
    this._buildMenu();
    this.refreshGlyphs();
    this.nav.current = null;
    this.nav.focus((key && this.$menu.querySelector(`[data-key="${key}"]`)) || this.$menu.querySelector('[data-nav]'), true);
  }

  onAction(a) {
    if (this.phase === 'press') { this.showMenu(); return true; }
    if (a === 'back') { this.showPress(); return true; }
    return super.onAction(a);
  }

  onDir(d) { if (this.phase === 'press') return false; return super.onDir(d); }

  onBackgroundClick() { if (this.phase === 'press') this.showMenu(); }

  update(dt) {
    this._t += dt;
    if (this.phase === 'press' && this._t > 0.4 && this.menus.anyPressed) this.showMenu();
    const dev = this.game.input && this.game.input.padType ? 'Controller' : 'Keyboard & mouse';
    if (this._dev !== dev) { this._dev = dev; this.$ver.textContent = `v1.0 · ${dev}`; }
    // the embedding page forbids the Gamepad API: explain why a pad does nothing
    const blocked = !!(this.game.input && this.game.input.gamepadBlocked);
    if (blocked !== this._padBlocked) {
      this._padBlocked = blocked;
      this.$padBlocked.classList.toggle('ls-hidden', !blocked);
      if (this.el) this.el.classList.toggle('padblocked', blocked);   // the version label moves up to make room
    }
  }
}

// ================================================================================================ confirm

export class ConfirmScreen extends Screen {
  constructor(menus, msg, sub = '', yes = 'Yes', no = 'No') {
    super(menus, { id: 'confirm', uiId: 'confirm', opaque: false });
    this.msg = msg; this.sub = sub; this.yes = yes; this.no = no;
  }
  render() {
    const el = h('div', 'ls-screen ls-confirm');
    el.innerHTML = `<div class="box"><div class="msg">${esc(this.msg)}</div>${this.sub ? `<div class="sub">${esc(this.sub)}</div>` : ''}
      <div class="btns"></div></div>`;
    const btns = el.querySelector('.btns');
    const mk = (label, v) => { const b = h('div', 'ls-btn', esc(label)); b.dataset.nav = ''; b._act = () => this.close(v); btns.appendChild(b); return b; };
    this.$no = mk(this.no, false);
    this.$yes = mk(this.yes, true);
    btns.insertBefore(this.$yes, this.$no);
    return el;
  }
  initialFocus() { return this.$no; }
  back() { sfx(this.game, 'ui_back'); this.close(false); }
}

// ================================================================================================ chapter select

export class ChapterSelectScreen extends Screen {
  constructor(menus) { super(menus, { id: 'chapters', uiId: null }); }
  render() {
    const fl = this.game.flow;
    const p = fl ? fl.progress : null;
    const order = CHAPTERS.map((c) => c.id);
    const open = p ? unlockedChapters(p, order) : [order[0]];
    const el = h('div', 'ls-screen ls-dim');
    el.innerHTML = `<div class="ls-page"><header><div><div class="ls-kick">Replay</div><h2 class="ls-h2">Chapters</h2></div>
      <div class="right">Age ${p ? p.age : 20}</div></header><div class="body"><div class="ls-chlist"></div></div></div>
      <div class="ls-hintbar">${hint('confirm', 'Play')}${hint('back', 'Back')}</div>`;
    const list = el.querySelector('.ls-chlist');
    for (const c of CHAPTERS) {
      const unlocked = open.includes(c.id);
      const done = p && p.completedChapters.includes(c.id);
      const { name } = splitBossName(c.boss ? c.boss.name : '');
      const entry = p && p.entryAge ? p.entryAge[c.id] : undefined;
      const row = h('div', `ls-ch${unlocked ? '' : ' locked'}${done ? ' done' : ''}`);
      row.innerHTML = `<div class="num">${roman(c.index)}</div>
        <div><div class="t">${unlocked ? esc(c.title) : 'Locked'}</div><div class="s">${unlocked ? `${esc(c.subtitle)} · ${esc(name)}` : 'Clear the previous chapter'}</div></div>
        <div class="m">${unlocked && entry ? `<b>${entry}</b>Entry age` : done ? '<b>✓</b>Cleared' : ''}</div>`;
      if (unlocked) {
        row.dataset.nav = '';
        row.dataset.key = c.id;
        row._act = () => { if (fl && typeof fl.playChapter === 'function') fl.playChapter(c.id); };
      }
      list.appendChild(row);
    }
    return el;
  }
  initialFocus() {
    const p = this.game.flow && this.game.flow.progress;
    return (p && this.el.querySelector(`[data-key="${p.chapterId}"]`)) || null;
  }
  back() { sfx(this.game, 'ui_back'); this.close(null); }
}

// ================================================================================================ style select

const EMBLEM = {
  forsaken: '<svg viewBox="0 0 64 64"><path d="M14 50 A26 26 0 0 1 50 14" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M22 54 A30 30 0 0 0 54 22" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M8 8 L40 40" stroke="currentColor" stroke-width="2.4"/><path d="M40 40 L33 39 M40 40 L39 33" stroke="currentColor" stroke-width="2.4"/></svg>',
  kahlt: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="32" cy="32" r="13" fill="currentColor" opacity=".85"/><path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="currentColor" stroke-width="1.4" opacity=".6"/></svg>',
  windfall: '<svg viewBox="0 0 64 64"><path d="M6 22 H38 a8 8 0 1 0 -8 -8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6 34 H50 a7 7 0 1 1 -7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M12 46 H28" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".6"/></svg>',
};

export class StyleSelectScreen extends Screen {
  constructor(menus) { super(menus, { id: 'style', uiId: null }); }
  render() {
    const el = h('div', 'ls-screen ls-dim');
    el.innerHTML = `<div class="ls-page"><header><div><div class="ls-kick">New game</div><h2 class="ls-h2">Choose your style</h2></div>
      <div class="right">${G('defend')}&nbsp; Defend button</div></header><div class="body"><div class="ls-styles"></div></div></div>
      <div class="ls-hintbar">${hint('confirm', 'Choose')}${hint('back', 'Back')}</div>`;
    const wrap = el.querySelector('.ls-styles');
    for (const id of ['forsaken', 'kahlt', 'windfall']) {
      const s = STYLES[id], c = STYLE_COPY[id];
      const card = h('div', 'ls-sty');
      card.innerHTML = `<div class="em">${EMBLEM[id]}</div><div class="nm">${esc(s.name)}</div><div class="ab">${esc(c.ability)}</div>
        <div class="ds">${esc(s.desc)}</div><div class="how">${esc(c.how)}</div><div class="tagl">${esc(c.tag)}</div>`;
      card.dataset.nav = '';
      card.dataset.key = id;
      card._act = () => this.close(id);
      wrap.appendChild(card);
    }
    return el;
  }
  back() { sfx(this.game, 'ui_back'); this.close(null); }
}

// ================================================================================================ credits

export class CreditsScreen extends Screen {
  constructor(menus) { super(menus, { id: 'credits', uiId: null }); }
  render() {
    const el = h('div', 'ls-screen ls-dim');
    const rows = CREDITS.map(([k, v], i) => i === 0
      ? `<div class="r"><div class="big">${esc(k.toUpperCase())}</div><div class="v" style="font-style:italic;color:var(--muted)">${esc(v)}</div></div>`
      : `<div class="r"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
    el.innerHTML = `<div class="ls-page"><div class="body"><div class="ls-credits"><div class="ls-seal" style="margin:0 0 .6em">${SEAL}</div>${rows}</div></div></div>
      <div class="ls-hintbar">${hint('back', 'Back')}</div>`;
    return el;
  }
  onAction(a) { if (a === 'confirm' || a === 'back') { sfx(this.game, 'ui_back'); this.close(null); return true; } return false; }
}

// ================================================================================================ pause

export class PauseScreen extends Screen {
  constructor(menus) { super(menus, { id: 'pause', uiId: 'pause', hidesHud: true, opaque: true }); }

  render() {
    const g = this.game, fl = g.flow, m = this.menus;
    const p = fl && fl.progress;
    const ch = CHAPTERS.find((c) => c.id === (fl && fl.chapterId));
    const el = h('div', 'ls-screen ls-pause');
    el.innerHTML = `<div class="wrap"><div class="ls-kick">Paused</div>
      <h2 class="ls-h2" style="margin-top:.35em">${ch ? esc(ch.title) : 'Last Stance'}</h2>
      <div class="meta">${ch ? `Chapter ${roman(ch.index)} · ` : ''}Age <b>${p ? p.age : 20}</b> · Deaths <b>${p ? p.deaths : 0}</b> · ${esc(STYLES[(p && p.style) || 'forsaken'].name)}</div>
      <div class="ls-menu"></div></div>
      <div class="side"><div class="ttl">Combat deck</div><div class="deck"></div></div>
      <div class="ls-hintbar">${hint('confirm', 'Select')}${hint('back', 'Resume')}</div>`;
    const menu = el.querySelector('.ls-menu');
    menu.appendChild(item('Resume', () => this.close(null)));
    const canDeck = !!(fl && typeof fl.canEditDeck === 'function' && fl.canEditDeck());
    const deck = item('Combat Deck', () => { if (canDeck) { this.close(null); m.openDeck(); } }, canDeck ? 'Rest point' : 'Only at rest points');
    if (!canDeck) deck.classList.add('disabled');
    menu.appendChild(deck);
    menu.appendChild(item('Settings', () => m.openSettings()));
    menu.appendChild(item('Controls', () => m.openControls()));
    menu.appendChild(item('Restart Chapter', async () => {
      if (await m.confirm('Restart this chapter?', 'You keep your age and learned moves. The rooms fill up again.', 'Restart', 'Cancel')) {
        this.close(null);
        if (fl && typeof fl.restartChapter === 'function') fl.restartChapter();
      }
    }));
    menu.appendChild(item('Quit to Title', async () => {
      if (await m.confirm('Quit to the title screen?', 'Progress is saved at the start of each chapter.', 'Quit', 'Cancel')) {
        this.close(null);
        if (fl && typeof fl.showTitle === 'function') fl.showTitle();
      }
    }));
    // deck summary
    const dk = el.querySelector('.deck');
    const pl = g.player, moves = g.combat && g.combat.MOVES;
    const d = (pl && pl.deck) || (p && p.deck) || {};
    for (const st of ['FL', 'FR', 'BL', 'BR']) {
      const s = d[st] || {};
      const a = moves && moves[s.main], b = moves && moves[s.alt];
      const row = h('div', 'row', `${stanceIcon(st, true)}<div class="mv"><div>${esc(a ? a.name : '—')}</div><div>${esc(b ? b.name : '—')}</div></div>`);
      dk.appendChild(row);
    }
    return el;
  }

  onAction(a) {
    if (a === 'back' || a === 'pause') { sfx(this.game, 'ui_back'); this.close(null); return true; }
    return super.onAction(a);
  }

  onUnmount() { this.game.setPaused(false); }
}

