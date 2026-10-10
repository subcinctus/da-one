// HUD text widgets: GTA help-text notifications (queued, max 3 on screen), big centred messages with letterbox
// bars (WASTED / BUSTED / MISSION PASSED), the per-frame contextual prompt with key caps, the mission objective
// subtitle, the mission timer, and the bottom-right vehicle / area name fade-ins.
import { el } from './styles.js';
import { richText, formatTimer } from './format.js';

const MAX_NOTES = 3;
const MAX_QUEUE = 12;

export class Notifier {
  constructor(hud) {
    this.hud = hud;
    this.queue = [];
    this.live = [];
    this.root = null;
  }

  mount(parent) { this.root = el('div', 'bc-notes', parent); }

  /** Queue a help-text box. Same text already on screen -> its timer restarts instead of stacking. */
  push(text, opts = {}) {
    if (text == null || text === '') return;
    text = String(text);
    const duration = Math.max(0.8, Number(opts.duration) || 4);
    const color = opts.color || null;
    for (const n of this.live) {
      if (n.text === text && !n.leaving) {
        n.left = duration;
        n.dur = duration;
        this._restartBar(n);
        return;
      }
    }
    const q = this.queue.find((n) => n.text === text);
    if (q) { q.dur = duration; return; }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({ text, dur: duration, color });
  }

  _restartBar(n) { n.barQ = -1; }

  _show(item) {
    const e = el('div', 'bc-note' + (item.color ? ' accent' : ''), this.root);
    if (item.color) e.style.setProperty('--c', item.color);
    e.innerHTML = richText(item.text);
    const bar = el('i', 'bar', e);
    this.live.push({ text: item.text, el: e, bar, barQ: -1, left: item.dur, dur: item.dur, leaving: false, gone: 0 });
  }

  /** Advance timers. `active` = false while the HUD is hidden (notes wait instead of expiring unseen). */
  update(dt, active) {
    if (!this.root) return;
    if (active) {
      while (this.queue.length && this.live.filter((n) => !n.leaving).length < MAX_NOTES) this._show(this.queue.shift());
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i];
      if (n.leaving) {
        n.gone -= dt;
        if (n.gone <= 0) { n.el.remove(); this.live.splice(i, 1); }
        continue;
      }
      if (!active) continue;
      n.left -= dt;
      if (n.left <= 0) { n.leaving = true; n.gone = 0.34; n.el.classList.add('out'); continue; }
      // remaining-time bar (quantised so the DOM is written ~30 times over a note's life)
      const q = Math.ceil((n.left / n.dur) * 30) / 30;
      if (q !== n.barQ) { n.barQ = q; n.bar.style.transform = 'scaleX(' + q.toFixed(3) + ')'; }
    }
  }

  clear() {
    this.queue.length = 0;
    for (const n of this.live) n.el.remove();
    this.live.length = 0;
  }
}

const AUTO_COLORS = [
  [/wasted/i, 'var(--wasted)'],
  [/busted/i, 'var(--busted)'],
  [/fail/i, '#e8473d'],
  [/passed|complete|success|record/i, 'var(--gold)'],
];

export class BigMessage {
  constructor(hud) {
    this.hud = hud;
    this.queue = [];
    this.cur = null;
    this.phase = 0;    // 0 idle, 1 showing, 2 hiding
    this.t = 0;
  }

  mount(parent) {
    this.root = el('div', 'bc-big', parent);
    el('div', 'lb t', this.root);
    el('div', 'lb b', this.root);
    const band = el('div', 'band', this.root);
    this.ttl = el('div', 'ttl', band);
    this.sub = el('div', 'sub', band);
  }

  get active() { return this.phase !== 0; }
  get title() { return this.cur ? this.cur.title : null; }

  /** Queue a message. opts.priority: drop the queue and cut the current message off; it starts on the next update. */
  push(title, subtitle = '', opts = {}) {
    title = String(title == null ? '' : title);
    const item = { title, subtitle: subtitle == null ? '' : String(subtitle), color: opts.color || null,
      duration: Math.max(1, Number(opts.duration) || 3) };
    if (this.cur && this.phase === 1 && this.cur.title.toUpperCase() === title.toUpperCase()) {
      // same message again: refresh text + timer
      this.cur = item;
      this.sub.innerHTML = richText(item.subtitle);
      this.t = item.duration;
      return;
    }
    if (opts.priority) {
      this.queue.length = 0;
      this.queue.push(item);
      if (this.phase !== 0) this._end();
      return;
    }
    if (this.queue.length > 3) this.queue.shift();
    this.queue.push(item);
  }

  /** Drop every queued and showing message titled `title` (case-insensitive), e.g. an abandoned mission's intro. */
  cancel(title) {
    const t = String(title == null ? '' : title).toUpperCase();
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].title.toUpperCase() === t) this.queue.splice(i, 1);
    if (!this.cur || this.phase !== 1 || this.cur.title.toUpperCase() !== t) return;
    if (this._showNext) this._end();   // started this frame, never drawn: just drop it
    else this.t = 0;                   // slides out on the next update
  }

  _end() {
    this.phase = 0;
    this.cur = null;
    this._showNext = false;
    if (this.root) this.root.className = 'bc-big';
  }

  _start(item) {
    this.cur = item;
    this.phase = 1;
    this.t = item.duration;
    let color = item.color;
    if (!color) { for (const [re, c] of AUTO_COLORS) if (re.test(item.title)) { color = c; break; } }
    this.root.style.setProperty('--c', color || '#ffffff');
    this.ttl.textContent = item.title;
    this.sub.innerHTML = richText(item.subtitle);
    this.sub.style.display = item.subtitle ? '' : 'none';
    this._base = 'bc-big on' + (/^(wasted|busted)$/i.test(item.title.trim()) ? '' : ' thin');
    // displayed off-screen this frame; 'show' is added on the next update so the bars slide in (no forced reflow)
    this.root.className = this._base;
    this._showNext = true;
  }

  update(dt, active) {
    if (this.phase === 0) {
      if (active && this.queue.length) this._start(this.queue.shift());
      return;
    }
    if (this._showNext) { this._showNext = false; this.root.className = this._base + ' show'; }
    if (!active && this.phase === 1) return;
    this.t -= dt;
    if (this.phase === 1 && this.t <= 0) {
      this.phase = 2;
      this.t = 0.6;
      this.root.className = this._base + ' show hide';
    } else if (this.phase === 2 && this.t <= 0) this._end();
  }

  /** Remove the current message (and optionally the queue). */
  dismiss(all = false) {
    if (all) this.queue.length = 0;
    if (this.phase === 1) { this.t = 0; }
  }
}

/** Bottom-centre stack: contextual prompt + objective subtitle. */
export class Subtitles {
  constructor(hud) {
    this.hud = hud;
    this._req = null;        // prompt requested this frame
    this._reqT = -1;         // realTime of the last request
    this._shown = null;
    this._obj = null;
    this._objShown = undefined;
  }

  mount(parent) {
    this.prompt = el('div', 'bc-prompt', parent);
    this.obj = el('div', 'bc-obj', parent);
  }

  request(text, now) {
    if (text == null || text === '') return;
    this._req = String(text);
    this._reqT = now;
  }

  setObjective(text) { this._obj = text == null || text === '' ? null : String(text); }

  update(now, allowPrompt) {
    // per-frame prompt: visible while requested (120 ms grace so every-other-frame callers do not flicker)
    const want = allowPrompt && this._req !== null && now - this._reqT < 0.12 ? this._req : null;
    if (want !== this._shown) {
      this._shown = want;
      if (want === null) this.prompt.classList.remove('on');
      else { this.prompt.innerHTML = richText(want); this.prompt.classList.add('on'); }
    }
    if (now - this._reqT >= 0.12) this._req = null;
    if (this._obj !== this._objShown) {
      this._objShown = this._obj;
      if (this._obj === null) this.obj.classList.remove('on');
      else {
        this.obj.innerHTML = richText(this._obj);
        this.obj.classList.add('on');
        if (this.obj.animate) {
          this.obj.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 400, easing: 'ease-out' });
        }
      }
    }
  }
}

/** Mission timer (top-centre). Counts down on simulated time between setTimer calls. */
export class MissionTimer {
  constructor(hud) {
    this.hud = hud;
    this.value = null;
    this.setAt = 0;
    this._txt = '';
    this._low = null;
    this._on = false;
  }

  mount(parent) {
    this.root = el('div', 'bc-timer', parent);
    el('span', 'lbl', this.root, 'TIME');
    this.val = el('span', 'val', this.root, '0:00');
  }

  set(sec, gameTime) {
    if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) { this.value = null; return; }
    this.value = Math.max(0, Number(sec));
    this.setAt = gameTime;
  }

  /** Remaining seconds (null when off). */
  remaining(gameTime) { return this.value === null ? null : Math.max(0, this.value - (gameTime - this.setAt)); }

  update(gameTime) {
    const rem = this.remaining(gameTime);
    const on = rem !== null;
    if (on !== this._on) { this._on = on; this.root.classList.toggle('on', on); }
    if (!on) return;
    const txt = formatTimer(rem, true);
    if (txt !== this._txt) { this._txt = txt; this.val.textContent = txt; }
    const low = rem <= 10;
    if (low !== this._low) { this._low = low; this.root.classList.toggle('low', low); }
  }
}

/** Vehicle name + area name fade-ins (bottom-right). */
export class Names {
  constructor(hud) {
    this.hud = hud;
    this.vT = 0;
    this.aT = 0;
  }

  mount(parent) {
    const box = el('div', 'bc-names', parent);
    this.vname = el('div', 'bc-vname', box);
    this.area = el('div', 'bc-area', box);
  }

  showVehicle(name) {
    if (!name) return;
    if (this.vname.textContent !== String(name)) this.vname.textContent = String(name);
    this.vname.classList.add('on');
    this.vT = 3.6;
  }

  showArea(name) {
    if (!name) return;
    if (this.area.textContent !== String(name)) this.area.textContent = String(name);
    this.area.classList.add('on');
    this.aT = 4.2;
  }

  update(dt) {
    if (this.vT > 0) { this.vT -= dt; if (this.vT <= 0) this.vname.classList.remove('on'); }
    if (this.aT > 0) { this.aT -= dt; if (this.aT <= 0) this.area.classList.remove('on'); }
  }
}
