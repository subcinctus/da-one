// Full-screen cards: chapter story, prologue, aging (Sifu), game over, victory, epilogue. Lines reveal one by one;
// A reveals the rest, then continues. Each card freezes the simulation (openUI) while it is up.
import { Screen } from './screen.js';
import { h, esc, roman, sfx } from './dom.js';
import { hint } from './glyphs.js';
import { CHAPTERS, PREMISE } from '../data/chapters.js';
import { CHAPTER_STORY, VICTORY, GAME_OVER, EPILOGUE } from '../game/story.js';
import { splitBossName } from './hud.js';

const LINE_GAP = 0.85;   // seconds between revealed lines

export class CardScreen extends Screen {
  /**
   * opts.kind: 'story' {chapterId} | 'premise' | 'aging' {from, to, counter, line, deaths} |
   *            'gameover' {age, line} | 'victory' {bossId, chapterId, age, deaths, learned} | 'epilogue'
   */
  constructor(menus, opts = {}) {
    super(menus, { id: 'card', uiId: 'card' });
    this.o = opts;
    this.kind = opts.kind || 'story';
    this.t = 0;
    this.revealed = 0;
    this.lines = [];
    this.minT = opts.minTime !== undefined ? opts.minTime : 0.5;
  }

  render() {
    const o = this.o;
    const el = h('div', 'ls-screen');
    if (this.kind === 'aging' || this.kind === 'gameover') return this._renderAging(el);
    el.className = 'ls-screen ls-card' + (this.kind === 'premise' ? ' premise' : '');
    let head = '', lines = [], joke = null, extra = '', cont = 'Continue';
    if (this.kind === 'story') {
      const ch = CHAPTERS.find((c) => c.id === o.chapterId) || CHAPTERS[0];
      const st = CHAPTER_STORY[ch.id] || { lines: [], joke: '' };
      head = `<div class="k">Chapter ${roman(ch.index)}</div><h1>${esc(ch.title)}</h1><div class="st">${esc(ch.subtitle)}</div><div class="rule"></div>`;
      lines = st.lines; joke = st.joke; cont = 'Begin';
    } else if (this.kind === 'premise') {
      head = '<div class="k">Seven years ago</div><div class="rule" style="margin-top:1.2em"></div>';
      lines = PREMISE.slice(0, -1); joke = null;
      extra = `<p class="last" style="margin-top:1.8em;font-style:normal;letter-spacing:.04em">${esc(PREMISE[PREMISE.length - 1])}</p>`;
      cont = 'Continue';
    } else if (this.kind === 'victory') {
      const ch = CHAPTERS.find((c) => c.id === o.chapterId) || CHAPTERS.find((c) => c.boss && c.boss.id === o.bossId) || CHAPTERS[0];
      const { name } = splitBossName(ch.boss ? ch.boss.name : o.bossId);
      const v = VICTORY[o.bossId] || VICTORY[ch.boss && ch.boss.id] || ['', ''];
      head = `<div class="k">Chapter ${roman(ch.index)} · ${esc(ch.title)} · Complete</div><h1 class="struck">${esc(name)}</h1><div class="rule"></div>`;
      lines = [v[0]]; joke = v[1];
      extra = `<div class="stats"><div><b>${o.age ?? '—'}</b>Age</div><div><b>${o.deaths ?? 0}</b>Deaths</div><div><b>${o.learned ?? 0}</b>Moves learned</div></div>`;
      cont = ch.index >= CHAPTERS.length ? 'Continue' : 'Next chapter';
    } else if (this.kind === 'epilogue') {
      head = '<div class="k">Epilogue</div><h1>The Lan Dojo</h1><div class="st">Spring</div><div class="rule"></div>';
      lines = EPILOGUE.slice(0, -1); joke = EPILOGUE[EPILOGUE.length - 1];
      cont = 'The end';
    }
    el.innerHTML = `${head}<div class="lines"></div>${extra}<div class="cont">${hint('confirm', cont)}</div>`;
    const box = el.querySelector('.lines');
    for (const l of lines) { const p = h('p', '', esc(l)); box.appendChild(p); this.lines.push(p); }
    if (joke) { const p = h('p', 'joke', esc(joke)); box.appendChild(p); this.lines.push(p); }
    const last = el.querySelector('p.last');
    if (last) { last.style.opacity = '0'; last.style.transition = 'opacity .8s'; this.lines.push(last); }
    const stats = el.querySelector('.stats');
    if (stats) { stats.style.opacity = '0'; stats.style.transition = 'opacity .8s'; this.lines.push(stats); }
    this.$cont = el.querySelector('.cont');
    return el;
  }

  _renderAging(el) {
    const o = this.o, over = this.kind === 'gameover';
    el.className = 'ls-screen ls-aging' + (over ? ' over' : '');
    const counter = Math.max(0, o.counter | 0);
    let pips = '';
    const n = Math.min(16, counter);
    for (let i = 0; i < n; i++) {
      const a = (-90 + (i - (n - 1) / 2) * 13) * Math.PI / 180;
      const x = 50 + Math.cos(a) * 46, y = 50 + Math.sin(a) * 46;
      pips += `<rect x="${(x - 1.8).toFixed(2)}" y="${(y - 1.8).toFixed(2)}" width="3.6" height="3.6" transform="rotate(45 ${x.toFixed(2)} ${y.toFixed(2)})" fill="${over ? '#e2553f' : '#5fbf9a'}"/>`;
    }
    const to = over ? 70 : o.to;
    el.innerHTML = `<div class="ring"><svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="41" fill="rgba(9,10,12,.45)" stroke="${over ? 'rgba(226,85,63,.7)' : 'rgba(95,191,154,.85)'}" stroke-width=".8"/>
        <circle class="arc" cx="50" cy="50" r="41" fill="none" stroke="${over ? '#e2553f' : '#5fbf9a'}" stroke-width="1.6"
          stroke-dasharray="257.6" stroke-dashoffset="257.6" transform="rotate(-90 50 50)"/>${pips}</svg>
        <div class="num">${o.from ?? to}</div></div>
      <div class="k">${over ? esc(GAME_OVER.title) : 'The talisman revives you'}</div>
      <div class="line">${esc(over ? GAME_OVER.lines.join(' ') : o.line || '')}</div>
      <div class="meta">${over ? `<span>Back to age<b>${o.entryAge ?? 20}</b></span>` : `<span>Death counter<b>${counter}</b></span><span>Deaths<b>${o.deaths ?? counter}</b></span>`}</div>
      <div class="ls-hintbar" style="opacity:0;transition:opacity .4s">${hint('confirm', over ? 'Begin again' : 'Rise')}</div>`;
    this.$num = el.querySelector('.num');
    this.$arc = el.querySelector('.arc');
    this.$line = el.querySelector('.line');
    this.$cont = el.querySelector('.ls-hintbar');
    this.from = o.from ?? to;
    this.to = to;
    this.ageDur = 1.1;
    this.minT = 0.9;
    return el;
  }

  onMount() {
    if (this.kind === 'aging' || this.kind === 'gameover') sfx(this.game, 'age_up');
    if (this.kind === 'victory') sfx(this.game, 'victory');
  }

  _allShown() {
    if (this.kind === 'aging' || this.kind === 'gameover') return this.t >= this.ageDur + 0.3;
    return this.revealed >= this.lines.length;
  }

  _showAll() {
    if (this.kind === 'aging' || this.kind === 'gameover') { this.t = Math.max(this.t, this.ageDur + 0.3); return; }
    for (const l of this.lines) { l.classList.add('on'); l.style.opacity = '1'; }
    this.revealed = this.lines.length;
  }

  update(dt) {
    this.t += dt;
    if (this.kind === 'aging' || this.kind === 'gameover') {
      const k = Math.min(1, this.t / this.ageDur);
      const e = 1 - Math.pow(1 - k, 3);
      const age = Math.round(this.from + (this.to - this.from) * e);
      if (age !== this._age) { this._age = age; this.$num.textContent = String(age); }
      const frac = Math.max(0, Math.min(1, (this.to - 20) / 50)) * e;
      this.$arc.setAttribute('stroke-dashoffset', (257.6 * (1 - frac)).toFixed(1));
      if (this.t > this.ageDur * 0.6) this.$line.classList.add('on');
    } else {
      const want = Math.min(this.lines.length, Math.floor((this.t - 0.35) / LINE_GAP) + 1);
      while (this.revealed < want) { const l = this.lines[this.revealed++]; l.classList.add('on'); l.style.opacity = '1'; }
    }
    if (this._allShown() && this.$cont && !this._contOn) {
      this._contOn = true;
      this.$cont.classList.add('on');
      this.$cont.style.opacity = '1';
    }
  }

  onAction(a) {
    if (a !== 'confirm' && a !== 'back' && a !== 'pause') return false;
    if (this.t < 0.25) return true;
    if (!this._allShown()) { this._showAll(); return true; }
    if (this.t < this.minT) return true;
    sfx(this.game, 'ui_select');
    this.close(true);
    return true;
  }

  onDir() { return false; }
  onBackgroundClick() { this.onAction('confirm'); }
}
