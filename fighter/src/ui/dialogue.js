// Dialogue overlay: listens to 'dialogue' events ({ speaker, text, mood, block? }) and shows a clean name plate + the
// line, typed out quickly. During a boss intro (lines arriving soon after 'bossIntro') or when `block: true`, the
// dialogue is BLOCKING: the sim freezes (openUI('dialogue')) and A advances, B skips the rest. Other lines (mid-fight
// barks, `block: false`) are subtitles that advance on their own.
import { h, sfx } from './dom.js';
import { G, refreshGlyphs } from './glyphs.js';
import { CHAPTERS } from '../data/chapters.js';
import { splitBossName } from './hud.js';

const CPS = 75;                 // typing speed (characters per second)
const INTRO_WINDOW = 8;         // sim seconds after bossIntro during which lines block

/** Display name for a speaker id / name. */
export function speakerName(s) {
  if (!s) return '';
  const k = String(s).toLowerCase();
  if (k === 'player' || k === 'you' || k === 'lan') return 'You';
  for (const c of CHAPTERS) if (c.boss && (c.boss.id === s || c.boss.id === k)) return splitBossName(c.boss.name).name;
  return String(s);
}

export class Dialogue {
  constructor(menus) {
    this.menus = menus;
    this.game = menus.game;
    this.queue = [];
    this.cur = null;
    this.blocking = false;
    this.introAt = -1e9;
    this.shown = 0;
    this.autoT = 0;
    this.linger = 0;
    this.el = h('div', 'ls-dlg', `<div class="panel"><div class="plate"></div><div class="text"></div>
      <div class="next">${G('confirm')}</div><div class="skip">${G('back')}&nbsp;Skip</div></div>`);
    this.$plate = this.el.querySelector('.plate');
    this.$text = this.el.querySelector('.text');
    this.$next = this.el.querySelector('.next');
    this.$skip = this.el.querySelector('.skip');
    this.el.addEventListener('click', () => { if (this.cur) this.advance(); });
    menus.layer.appendChild(this.el);
    this._pad = undefined;
  }

  /** Queue a line. */
  push(e) {
    if (!e || !e.text) return;
    this.queue.push({ speaker: e.speaker || '', text: String(e.text), mood: e.mood || '', block: e.block, bark: !!e.bark,
      duration: typeof e.duration === 'number' && e.duration > 0 ? e.duration : 0 });
    if (!this.cur) this._next();
  }

  /** Lines that follow a boss intro block the simulation. */
  markIntro() { this.introAt = this.game.time; }

  _next() {
    const line = this.queue.shift() || null;
    this.cur = line;
    if (!line) { this._end(); return; }
    const block = typeof line.block === 'boolean' ? line.block : (this.game.time - this.introAt) < INTRO_WINDOW;
    if (block && !this.blocking) { this.blocking = true; this.game.openUI('dialogue'); }
    else if (!block && this.blocking) { this.blocking = false; this.game.closeUI('dialogue'); }
    const name = speakerName(line.speaker);
    this.$plate.textContent = name;
    this.$plate.classList.toggle('you', name === 'You');
    this.$plate.style.display = name ? '' : 'none';
    this.$text.className = 'text' + (/^[a-z]+$/.test(line.mood) ? ' ' + line.mood : '');
    this.$text.textContent = '';
    this.shown = 0;
    this.el.classList.toggle('bark', !block);
    this.el.classList.toggle('block', block);
    this.autoT = line.duration || 1.6 + line.text.length * 0.05;
    this.linger = 0;
    this.$next.classList.remove('on');
    this.$skip.style.display = this.blocking && this.queue.length ? '' : 'none';
    this.el.classList.add('on');
  }

  _end() {
    this.cur = null;
    if (this.blocking) { this.blocking = false; this.game.closeUI('dialogue'); }
    this.linger = 0.45;   // keep the last line up briefly so back-to-back lines do not flicker
  }

  /** A: finish typing, or go to the next line. */
  advance() {
    if (!this.cur) return;
    if (this.shown < this.cur.text.length) { this.shown = this.cur.text.length; this.$text.textContent = this.cur.text; this.$next.classList.add('on'); return; }
    sfx(this.game, 'ui_select');
    this._next();
  }

  /** B: drop the remaining queued lines. */
  skipAll() {
    if (!this.cur) return;
    sfx(this.game, 'ui_back');
    this.queue.length = 0;
    this._next();
  }

  /** Remove everything at once (chapter change / title). */
  clear() {
    this.queue.length = 0;
    this.cur = null;
    if (this.blocking) { this.blocking = false; this.game.closeUI('dialogue'); }
    this.linger = 0;
    this.el.classList.remove('on');
  }

  update(dt) {
    const pad = this.game.input ? this.game.input.padType : null;
    if (pad !== this._pad) { this._pad = pad; refreshGlyphs(this.el, pad); }
    if (!this.cur) {
      if (this.linger > 0) { this.linger -= dt; if (this.linger <= 0) this.el.classList.remove('on'); }
      return;
    }
    const len = this.cur.text.length;
    if (this.shown < len) {
      const n = Math.min(len, this.shown + Math.max(1, Math.round(CPS * dt)));
      if (n !== this.shown) { this.shown = n; this.$text.textContent = this.cur.text.slice(0, n); }
      if (n >= len) this.$next.classList.toggle('on', this.blocking);
    }
    // hold the boss-intro camera on the speaker while the player reads (the cinematic runs in real time)
    if (this.blocking) {
      const cr = this.game.cameraRig, c = cr && cr._cine;
      if (c && c.on && typeof c.t === 'number' && typeof c.dur === 'number') c.dur = Math.max(c.dur, c.t + 0.6);
    } else {
      this.autoT -= dt;
      if (this.autoT <= 0 && !this.game.paused && !this.game.isUIOpen('card')) this._next();
    }
  }
}
