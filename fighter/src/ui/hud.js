// HUD (system game.hud): minimal, Absolver-like. Thin bars, elegant type, nothing that does not earn its place.
//   bottom-left   jade talisman with the age (Sifu) + death counter, health (with damage chip), stamina, focus pips
//   bottom-right  the stance quadrant (4 diamonds, current lit, flash on change) + current main / alt move names
//   bottom-centre boss bar with name; contextual prompts above it
//   world-space   small enemy bars (only when damaged or targeted) and the lock-on chevron just above the target's bar
//   right         toasts (learned moves, learn progress ticks, rest points)
// Also owns the loading screen. DOM writes happen only when a value changes; projection scratch is preallocated.
// The viewport size is cached (onResize), and world markers are projected first and written after, so a frame never
// forces a synchronous layout.
import * as THREE from 'three';
import { injectCSS } from './style.js';
import { h, esc, uiRoot, sfx, roman } from './dom.js';
import { G, refreshGlyphs } from './glyphs.js';
import { CHAPTERS } from '../data/chapters.js';

const EBARS = 8;
/** Loading screen lines per system (main.js reports 'Loading <system>...'). */
const LOAD_TEXT = {
  hud: 'Interface', menus: 'Menus', audio: 'Tuning the strings', anim: 'Stretching', world: 'Sweeping the dojo', fx: 'Chalk and sparks',
  cameraRig: 'Camera', combat: 'Four stances', ai: 'Waking the syndicate', encounters: 'Locking the doors', flow: 'Lighting incense',
};
const QUAD = { FL: [30, 30], FR: [70, 30], BL: [30, 70], BR: [70, 70] };
const BAR_LIFT = 0.16;      // enemy bars (and the lock chevron, which sits just above the bar) at height + this
/** Shown once when the embedding page blocks the Gamepad API (title notice + first gameplay frame toast). */
export const PAD_BLOCKED_TEXT = ['Controller blocked by the page embedding the game.', 'Open it in its own tab to use a pad.'];
const _v = new THREE.Vector3();
const bossInfo = (id) => { for (const c of CHAPTERS) if (c.boss && c.boss.id === id) return c.boss; return null; };

/** Split 'Tadao "The Accountant"' into name + epithet. */
export function splitBossName(full) {
  const m = /^(.*?)\s*"(.+)"\s*$/.exec(full || '');
  return m ? { name: m[1], epithet: m[2] } : { name: full || '', epithet: '' };
}

export class HUD {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.root = null;
    this.el = null;
    this._loading = null;
    this._shown = null;
    this._pad = undefined;
    this._prompts = new Map();
    this._toasts = new Map();
    this._hitAt = new WeakMap();
    this._fpsT = 0;
    this._v = {};             // last written values
    this._chip = 1; this._chipHold = 0;
    this._bossChip = 1; this._bossHold = 0; this._boss = null; this._bossGone = 0;
    this._target = null;
    this._stance = null; this._mainId = undefined; this._altId = undefined; this._deck = null;
    this._usedT = 0;
    this._bannerT = 0; this._bossTitleT = 0;
    this._vw = 0; this._vh = 0;   // cached viewport size in CSS pixels (onResize)
    this._padBlockedShown = false;
  }

  // ---------------------------------------------------------------------------------------------- loading screen

  /** Loading progress 0..1 with a status line (called before init()). */
  setLoading(p, text) {
    injectCSS();
    if (!this._loading) {
      const el = h('div', 'ls-loading', '<div class="t">LAST STANCE</div><div class="bar"><i></i></div><div class="s"></div>');
      uiRoot().appendChild(el);
      this._loading = el;
    }
    const v = Math.max(0, Math.min(1, +p || 0));
    this._loading.querySelector('.bar i').style.transform = `scaleX(${v.toFixed(3)})`;
    const m = /^Loading (\w+)/.exec(text || '');
    this._loading.querySelector('.s').textContent = m ? (LOAD_TEXT[m[1]] || m[1]) : text ? String(text).replace(/\.\.\.$/, '') : '';
  }

  /** Fade the loading screen out. */
  hideLoading() {
    const el = this._loading;
    if (!el) return;
    el.style.opacity = '0';
    el.style.pointerEvents = 'none';
    setTimeout(() => { el.remove(); if (this._loading === el) this._loading = null; }, 700);
  }

  // ---------------------------------------------------------------------------------------------- build

  init() {
    injectCSS();
    const g = this.game;
    this.root = uiRoot();
    const el = this.el = h('div', 'ls-layer ls-hud off');
    el.innerHTML = `
      <div class="ls-fps ls-hidden"></div>
      <div class="ls-player">
        <div class="ls-tal">
          <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="47" fill="rgba(10,11,13,.42)" stroke="rgba(95,191,154,.85)" stroke-width="1.6"/>
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(95,191,154,.35)" stroke-width="1"/>
          <path d="M50 3v6M50 91v6M3 50h6M91 50h6" stroke="rgba(95,191,154,.85)" stroke-width="1.6"/></svg>
          <div class="age">20</div><div class="cnt zero">0</div>
        </div>
        <div class="ls-bars">
          <div class="ls-bar hp"><i class="chip"></i><i class="fill"></i></div>
          <div class="ls-bar st"><i class="fill"></i></div>
          <div class="ls-focus"><div class="pip"><i></i></div><div class="pip"><i></i></div><span class="lbl">${G('focus')}&nbsp;FOCUS</span></div>
        </div>
      </div>
      <div class="ls-stance">
        <div class="ls-moves">
          <div class="ls-mv main">${G('light')}<span class="n">—</span><span class="to"></span></div>
          <div class="ls-mv alt">${G('heavy')}<span class="n">—</span><span class="to"></span></div>
        </div>
        <div class="ls-quad">
          <svg viewBox="0 0 100 100">${Object.entries(QUAD).map(([k, [x, y]]) =>
            `<rect class="d" data-st="${k}" x="${x - 13}" y="${y - 13}" width="26" height="26" transform="rotate(45 ${x} ${y})"/>` +
            `<text class="lbl" data-st="${k}" x="${x}" y="${y}">${k}</text>`).join('')}</svg>
          <div class="ls-string"><i></i><i></i><i></i></div>
        </div>
      </div>
      <div class="ls-boss"><div class="nm"></div><div class="ep"></div><div class="ls-bar"><i class="chip"></i><i class="fill"></i><span class="tick"></span></div></div>
      <div class="ls-prompt"></div>
      <div class="ls-ret"><svg viewBox="-10 -7 20 14"><path d="M-8 -5 L0 3 L8 -5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="miter"/>
        <path d="M-3.2 0.6 L0 3.8 L3.2 0.6 L0 6 Z" fill="currentColor"/></svg></div>`;
    this.root.appendChild(el);
    // overlay above the menu layer: toasts (also over the deck editor), chapter banner, boss title (over dialogue)
    const ov = this.overlay = h('div', 'ls-layer ls-overlay', `<div class="ls-toasts"></div>
      <div class="ls-banner"><div class="k"></div><div class="t"></div><div class="r"></div><div class="s"></div></div>
      <div class="ls-bosstitle"><div class="k">Chapter boss</div><div class="n"></div><div class="r"></div><div class="b"></div></div>`);
    this.root.appendChild(ov);
    const q = (s) => el.querySelector(s) || ov.querySelector(s);
    this.$ = {
      fps: q('.ls-fps'), tal: q('.ls-tal'), age: q('.ls-tal .age'), cnt: q('.ls-tal .cnt'),
      hp: q('.ls-bar.hp .fill'), chip: q('.ls-bar.hp .chip'), stBar: q('.ls-bar.st'), st: q('.ls-bar.st .fill'),
      focus: q('.ls-focus'), pips: el.querySelectorAll('.ls-focus .pip i'),
      quad: q('.ls-quad'), diamonds: el.querySelectorAll('.ls-quad .d'), labels: el.querySelectorAll('.ls-quad .lbl'),
      string: q('.ls-string'), strPips: el.querySelectorAll('.ls-string i'),
      mvMain: q('.ls-mv.main'), mvAlt: q('.ls-mv.alt'),
      mainN: q('.ls-mv.main .n'), mainTo: q('.ls-mv.main .to'), altN: q('.ls-mv.alt .n'), altTo: q('.ls-mv.alt .to'),
      boss: q('.ls-boss'), bossName: q('.ls-boss .nm'), bossEp: q('.ls-boss .ep'), bossFill: q('.ls-boss .fill'), bossChip: q('.ls-boss .chip'),
      prompt: q('.ls-prompt'), toasts: q('.ls-toasts'),
      banner: q('.ls-banner'), bossTitle: q('.ls-bosstitle'), ret: q('.ls-ret'),
    };
    this.$.string.style.opacity = '0';
    this._ebars = [];
    for (let i = 0; i < EBARS; i++) {
      const b = h('div', 'ls-ebar', '<i class="chip"></i><i class="fill"></i>');
      el.appendChild(b);
      // nx / ny / vis: this frame's projection (read pass), written to the DOM in the write pass
      this._ebars.push({ el: b, fill: b.firstChild.nextSibling, chip: b.firstChild, f: null, on: false, hp: -1, chipV: 1, x: -1, y: -1, nx: 0, ny: 0, vis: false, hitAgo: 99, cq: -1 });
    }
    this._readSize();

    const ev = g.events;
    ev.on('hit', (e) => { if (e && e.defender) this._hitAt.set(e.defender, g.realTime); });
    ev.on('stanceChanged', (e) => { if (e && e.fighter === g.player) this._flashQuad(); });
    ev.on('staminaOut', (e) => { if (e && e.fighter === g.player) this._restart(this.$.stBar, 'out'); });
    ev.on('focusDenied', (e) => { if (e && e.fighter === g.player) this._restart(this.$.focus, 'deny'); });
    ev.on('attackStart', (e) => {
      if (!e || e.fighter !== g.player || !e.move) return;
      const p = g.player, slot = p.deck && p.deck[p.stance];
      const which = slot && slot.alt === e.move.id ? this.$.mvAlt : slot && slot.main === e.move.id ? this.$.mvMain : null;
      this.$.mvMain.classList.toggle('used', which === this.$.mvMain);
      this.$.mvAlt.classList.toggle('used', which === this.$.mvAlt);
      this._usedT = 0.35;
    });
    ev.on('learnProgress', (e) => { if (e && e.moveId) this.learnToast(e.moveId, e.value, e.max); });
    ev.on('learned', (e) => {
      if (!e || !e.moveId) return;
      this._dropToast('learn:' + e.moveId);
      this.toast(this._moveName(e.moveId), { kind: 'learn', key: 'learned:' + e.moveId, label: 'Learned', ms: 4200,
        sub: 'Edit your deck at the next rest point' });
      sfx(g, 'learned');
    });
    ev.on('playerAged', () => this._restart(this.$.tal, 'pulse'));
    ev.on('deathCounterRelief', () => this._restart(this.$.tal, 'pulse'));
    ev.on('bossIntro', (e) => this.bossTitle(e && e.bossId, e));
    ev.on('settingsChanged', () => this._applySettings());
    ev.on('chapterStart', () => { this._boss = null; this.$.boss.classList.remove('on'); });
    this._applySettings();
  }

  _applySettings() { if (this.$) this.$.fps.classList.toggle('ls-hidden', !this.game.settings.showFPS); }

  /** Viewport size (system interface): cached so projecting a marker never reads layout. */
  onResize(w, hgt) {
    if (w > 0 && hgt > 0) { this._vw = w; this._vh = hgt; } else this._readSize();
  }
  _readSize() {
    const c = this.game.container;
    this._vw = (c && c.clientWidth) || window.innerWidth || 1;
    this._vh = (c && c.clientHeight) || window.innerHeight || 1;
  }

  _restart(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  _flashQuad() { this._restart(this.$.quad, 'flash'); }

  _moveName(id) {
    const m = this._move(id);
    return m ? m.name : (id || '—');
  }
  _move(id) {
    if (!id) return null;
    const t = this.game.combat && this.game.combat.MOVES;
    return (t && t[id]) || null;
  }

  // ---------------------------------------------------------------------------------------------- public API

  /**
   * Show a toast. opts: { kind: 'info' | 'learn' | 'warn', label (small caps kicker), sub, ms, key (replace in place) }.
   */
  toast(text, opts = {}) {
    if (!this.$) return null;
    const key = opts.key || null;
    let t = key ? this._toasts.get(key) : null;
    if (!t) {
      const el = h('div', 'ls-toast ' + (opts.kind || 'info'));
      this.$.toasts.appendChild(el);
      t = { el, timer: 0, key };
      if (key) this._toasts.set(key, t);
      while (this.$.toasts.children.length > 5) this.$.toasts.firstChild.remove();
    }
    t.el.className = 'ls-toast ' + (opts.kind || 'info');
    t.el.innerHTML = `${opts.label ? `<span class="k">${esc(opts.label)}</span>` : ''}<div class="v">${esc(text)}</div>` +
      (opts.sub ? `<div class="k" style="margin:.3em 0 0;color:var(--muted);letter-spacing:.12em">${esc(opts.sub)}</div>` : '') + (opts.html || '');
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.el.classList.add('out');
      setTimeout(() => { t.el.remove(); if (key && this._toasts.get(key) === t) this._toasts.delete(key); }, 480);
    }, opts.ms || 2600);
    return t.el;
  }

  _dropToast(key) {
    const t = this._toasts.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    t.el.remove();
    this._toasts.delete(key);
  }

  /** Learn progress for a move: ticks fill in place (one toast per move). */
  learnToast(moveId, value, max) {
    const m = Math.max(1, +max || 1), v = Math.max(0, Math.min(m, +value || 0));
    const n = 10, on = Math.round((v / m) * n);
    const prevKey = 'learn:' + moveId;
    const prev = this._toasts.get(prevKey);
    const prevOn = prev ? prev.on || 0 : 0;
    let ticks = '';
    for (let i = 0; i < n; i++) ticks += `<i class="${i < on ? (i >= prevOn ? 'on new' : 'on') : ''}"></i>`;
    this.toast(this._moveName(moveId), { kind: 'learn', key: prevKey, label: 'Learning', ms: 3000,
      html: `<div class="ls-ticks">${ticks}</div>` });
    const t = this._toasts.get(prevKey);
    if (t) t.on = on;
  }

  /** Big centred banner (chapter titles). */
  banner(kicker, title, sub = '', seconds = 3.2) {
    if (!this.$) return;
    const b = this.$.banner;
    b.querySelector('.k').textContent = kicker || '';
    b.querySelector('.t').textContent = title || '';
    b.querySelector('.s').textContent = sub || '';
    b.classList.add('on');
    this._bannerT = seconds;
  }

  /** Sifu-style boss title over the intro cinematic. */
  bossTitle(bossId, payload = null) {
    if (!this.$) return;
    const info = bossInfo(bossId) || {};
    const full = (payload && payload.fullName) || info.name || (payload && payload.name) || bossId || '';
    const { name, epithet } = splitBossName(full);
    const ch = CHAPTERS.find((c) => c.boss && c.boss.id === bossId);
    const el = this.$.bossTitle;
    el.querySelector('.k').textContent = epithet || (ch ? `Chapter ${roman(ch.index)} boss` : 'Boss');
    el.querySelector('.n').textContent = name;
    el.querySelector('.b').textContent = (payload && payload.blurb) || info.blurb || '';
    el.classList.add('on');
    this._bossTitleT = 3.6;
  }

  /** Contextual prompt (key -> {action, text, sub}) or null to remove. */
  setPrompt(key, p) {
    if (!this.$) return;
    const cur = this._prompts.get(key);
    if (!p) { if (cur) { cur.el.remove(); this._prompts.delete(key); } return; }
    const sig = `${p.action}|${p.text}|${p.sub || ''}`;
    if (cur && cur.sig === sig) return;
    const el = cur ? cur.el : h('span', 'p');
    el.innerHTML = `${p.action ? G(p.action) : ''}<span class="t">${esc(p.text)}</span>${p.sub ? `<span class="s">${esc(p.sub)}</span>` : ''}`;
    if (!cur) this.$.prompt.appendChild(el);
    this._prompts.set(key, { el, sig });
    this._pad = undefined;   // refresh glyphs
  }

  /** True when the HUD is currently shown. */
  get visible() { return !!this._shown; }

  // ---------------------------------------------------------------------------------------------- frame

  update(dt) {
    if (!this.el) return;
    const g = this.game;
    const p = g.player;
    const menus = g.menus;
    const show = g.state === 'playing' && !!p && !(menus && typeof menus.hudHidden === 'function' && menus.hudHidden());
    if (show !== this._shown) { this._shown = show; this.el.classList.toggle('off', !show); }
    const covered = g.state !== 'playing' || !!(menus && typeof menus.covered === 'function' && menus.covered());
    if (covered !== this._covered) { this._covered = covered; this.overlay.classList.toggle('covered', covered); }
    // FPS
    if (g.settings.showFPS) {
      this._fpsT -= dt;
      if (this._fpsT <= 0) { this._fpsT = 0.25; this.$.fps.textContent = Math.round(g.fps) + ' FPS'; }
    }
    // glyphs follow the active device
    const pad = g.input ? g.input.padType : null;
    if (pad !== this._pad) { this._pad = pad; refreshGlyphs(this.el, pad); refreshGlyphs(this.overlay, pad); }
    // timers
    if (this._bannerT > 0) {
      this._bannerT -= dt;
      // a bark (top-centre subtitle) takes the banner's place: the banner is decoration, the line is content
      const dl = menus && menus.dialogue;
      if (dl && dl.cur && !dl.blocking) this._bannerT = 0;
      if (this._bannerT <= 0) this.$.banner.classList.remove('on');
    }
    if (this._bossTitleT > 0) { this._bossTitleT -= dt; if (this._bossTitleT <= 0) this.$.bossTitle.classList.remove('on'); }
    if (this._usedT > 0) { this._usedT -= dt; if (this._usedT <= 0) { this.$.mvMain.classList.remove('used'); this.$.mvAlt.classList.remove('used'); } }
    if (!show) { this._hideWorld(); return; }
    // the page embedding the game blocks the Gamepad API: say so once, on the first gameplay frame
    if (!this._padBlockedShown && g.input && g.input.gamepadBlocked) {
      this._padBlockedShown = true;
      this.toast(PAD_BLOCKED_TEXT[0], { kind: 'warn', label: 'Controller', sub: PAD_BLOCKED_TEXT[1], ms: 7000, key: 'pad-blocked' });
    }

    this._updatePlayer(dt, p);
    this._updateStance(p);
    this._updateBoss(dt);
    this._updateWorld(dt, p);
  }

  // change-only DOM writers (no closures: nothing allocated per frame unless a value changed)
  _scale(key, el, v) { if (this._v[key] !== v) { this._v[key] = v; el.style.transform = 'scaleX(' + v + ')'; } }
  _cls(key, el, cls, on) { if (this._v[key] !== on) { this._v[key] = on; el.classList.toggle(cls, on); } }
  _text(key, el, v) { if (this._v[key] !== v) { this._v[key] = v; el.textContent = String(v); } }

  _updatePlayer(dt, p) {
    const $ = this.$;
    const hp = p.maxHealth > 0 ? Math.max(0, Math.min(1, p.health / p.maxHealth)) : 0;
    if (hp >= this._chip) { this._chip = hp; this._chipHold = 0; }
    else if (this._v.hp !== undefined && hp < this._v.hp) this._chipHold = 0.45;
    else if (this._chipHold > 0) this._chipHold -= dt;
    else this._chip = Math.max(hp, this._chip - dt * 0.9);
    this._scale('hp', $.hp, Math.round(hp * 1000) / 1000);
    this._scale('chip', $.chip, Math.round(this._chip * 1000) / 1000);
    const st = p.maxStamina > 0 ? Math.max(0, Math.min(1, p.stamina / p.maxStamina)) : 0;
    this._scale('st', $.st, Math.round(st * 500) / 500);
    this._cls('stLow', $.stBar, 'low', st < 0.25);
    const f = Math.max(0, Math.min(100, p.focus || 0));
    this._scale('f1', $.pips[0], Math.round(Math.min(1, f / 50) * 200) / 200);
    this._scale('f2', $.pips[1], Math.round(Math.max(0, Math.min(1, (f - 50) / 50)) * 200) / 200);
    this._cls('fReady', $.focus, 'ready', !!p.focusReady || f >= 50);
    const prog = this.game.flow && this.game.flow.progress;
    const age = prog ? Math.min(70, prog.age | 0) : 20;
    const cnt = prog ? prog.deathCounter | 0 : 0;
    this._text('age', $.age, age);
    this._text('cnt', $.cnt, cnt);
    this._cls('cnt0', $.cnt, 'zero', cnt === 0);
  }

  _updateStance(p) {
    const $ = this.$;
    const st = p.stance;
    if (st !== this._stance) {
      this._stance = st;
      for (const d of $.diamonds) d.classList.toggle('on', d.dataset.st === st);
      for (const l of $.labels) l.classList.toggle('on', l.dataset.st === st);
      this._mainId = undefined;
    }
    const slot = p.deck && p.deck[st];
    const mainId = slot ? slot.main : null, altId = slot ? slot.alt : null;
    if (mainId !== this._mainId || altId !== this._altId) {
      this._mainId = mainId; this._altId = altId;
      const a = this._move(mainId), b = this._move(altId);
      $.mainN.textContent = a ? a.name : '—';
      $.mainTo.textContent = a ? `→ ${a.end}` : '';
      $.altN.textContent = b ? b.name : '—';
      $.altTo.textContent = b ? `→ ${b.end}` : '';
    }
    const n = p.state === 'attack' ? Math.max(0, Math.min(3, p.stringIndex | 0)) : 0;
    if (this._v.str !== n) {
      this._v.str = n;
      $.string.style.opacity = n > 0 ? '1' : '0';
      for (let k = 0; k < 3; k++) $.strPips[k].classList.toggle('on', k < n);
    }
  }

  _updateBoss(dt) {
    const $ = this.$;
    const c = this.game.combat;
    let boss = null;
    if (c && c.fighters) for (const f of c.fighters) if (f.boss && !f.removed && (f.alive || f === this._boss)) { boss = f; if (f.alive) break; }
    if (boss !== this._boss) {
      this._boss = boss;
      this._bossChip = 1; this._v.bossHp = undefined;
      if (boss) {
        const info = bossInfo(boss.boss);
        const { name, epithet } = splitBossName((info && info.name) || boss.name || boss.boss);
        $.bossName.textContent = name;
        $.bossEp.textContent = epithet;
      }
      this._bossGone = 0;
    }
    if (!boss) { this._cls('bossOn', $.boss, 'on', false); return; }
    if (!boss.alive) { this._bossGone += dt; }
    this._cls('bossOn', $.boss, 'on', this._bossGone < 1.6);
    const hp = boss.maxHealth > 0 ? Math.max(0, Math.min(1, boss.health / boss.maxHealth)) : 0;
    if (hp >= this._bossChip) { this._bossChip = hp; this._bossHold = 0; }
    else if (this._v.bossHp !== undefined && hp < this._v.bossHp) this._bossHold = 0.5;
    else if (this._bossHold > 0) this._bossHold -= dt;
    else this._bossChip = Math.max(hp, this._bossChip - dt * 0.6);
    this._scale('bossHp', $.bossFill, Math.round(hp * 1000) / 1000);
    this._scale('bossChip', $.bossChip, Math.round(this._bossChip * 1000) / 1000);
  }

  /** Project a world point to CSS pixels into _v (x, y); returns false when off-screen / behind. No layout reads. */
  _project(x, y, z) {
    const g = this.game;
    _v.set(x, y, z).project(g.camera);
    if (_v.z < -1 || _v.z > 1) return false;
    if (!(this._vw > 0)) this._readSize();
    const w = this._vw, hgt = this._vh;
    _v.x = (_v.x * 0.5 + 0.5) * w;
    _v.y = (-_v.y * 0.5 + 0.5) * hgt;
    return _v.x > -50 && _v.x < w + 50 && _v.y > -50 && _v.y < hgt + 50;
  }

  _updateWorld(dt, p) {
    const g = this.game;
    const c = g.combat;
    const fs = c && c.fighters ? c.fighters : [];
    const target = p.target && p.target.alive ? p.target : null;
    // read pass: pick the fighters that want a bar and project them (math only, no DOM)
    let n = 0;
    for (let i = 0; i < fs.length && n < EBARS; i++) {
      const f = fs[i];
      if (f === p || f.team === 'player' || f.boss || f.removed) continue;
      const hitAgo = g.realTime - (this._hitAt.get(f) || -99);
      const damaged = f.maxHealth > 0 && f.health < f.maxHealth;
      const want = f.alive && (f === target || hitAgo < 5 || damaged);
      if (!want) continue;
      const b = this._ebars[n++];
      if (b.f !== f) { b.f = f; b.chipV = f.maxHealth > 0 ? f.health / f.maxHealth : 1; b.hp = -1; b.cq = -1; }
      b.hitAgo = hitAgo;
      const root = f.model && f.model.root ? f.model.root.position : f.position;
      b.vis = this._project(root.x, (f.height || 1.8) + BAR_LIFT, root.z);
      if (b.vis) { b.nx = Math.round(_v.x); b.ny = Math.round(_v.y); }
    }
    // the lock chevron sits just above the target's bar (CSS offset), clear of the torso and the arms' wind-ups
    let retVis = false, rx = 0, ry = 0;
    if (target) {
      const r = target.model && target.model.root ? target.model.root.position : target.position;
      retVis = this._project(r.x, (target.height || 1.8) + BAR_LIFT, r.z);
      if (retVis) { rx = Math.round(_v.x); ry = Math.round(_v.y); }
    }
    // write pass
    for (let i = 0; i < n; i++) {
      const b = this._ebars[i], f = b.f;
      if (!b.vis) { if (b.on) { b.on = false; b.el.classList.remove('on'); } continue; }
      if (b.nx !== b.x || b.ny !== b.y) { b.x = b.nx; b.y = b.ny; b.el.style.transform = 'translate3d(' + b.x + 'px,' + b.y + 'px,0)'; }
      if (!b.on) { b.on = true; b.el.classList.add('on'); }
      const hp = Math.max(0, Math.min(1, f.health / Math.max(1, f.maxHealth)));
      if (hp > b.chipV) b.chipV = hp; else b.chipV = Math.max(hp, b.chipV - dt * (b.hitAgo > 0.45 ? 0.9 : 0));
      const hq = Math.round(hp * 200) / 200;
      if (hq !== b.hp) { b.hp = hq; b.fill.style.transform = 'scaleX(' + hq + ')'; }
      const cq = Math.round(b.chipV * 200) / 200;
      if (cq !== b.cq) { b.cq = cq; b.chip.style.transform = 'scaleX(' + cq + ')'; }
    }
    for (let i = n; i < EBARS; i++) { const b = this._ebars[i]; if (b.on) { b.on = false; b.f = null; b.el.classList.remove('on'); } }

    const ret = this.$.ret;
    if (target !== this._target) {
      this._target = target;
      this._v.retOn = !!target;
      ret.classList.toggle('on', !!target);
      if (target) { this._v.rx = this._v.ry = undefined; this._lockin = true; }
    }
    if (target) {
      if (retVis) {
        if (rx !== this._v.rx || ry !== this._v.ry) { this._v.rx = rx; this._v.ry = ry; ret.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)'; }
        this._cls('retOn', ret, 'on', true);
      } else this._cls('retOn', ret, 'on', false);
    }
    // restart the lock-in animation last: it reads layout (offsetWidth), so after every write of this frame
    if (this._lockin) { this._lockin = false; if (target) this._restart(ret, 'lockin'); }
  }

  _hideWorld() {
    if (!this._ebars) return;
    for (const b of this._ebars) if (b.on) { b.on = false; b.f = null; b.el.classList.remove('on'); }
    if (this._target) { this._target = null; this._v.retOn = false; this.$.ret.classList.remove('on'); }
  }
}
