// Mission-specific HUD widgets (own DOM, mounted under #ui): the objective tracker card (top-centre under the HUD
// timer: progress rows like "PACKAGES 2/5", "DEMOLISHED 23% / 35%", race checkpoint + split), the race countdown
// (3-2-1-GO), and short centre "flash" lines (checkpoint splits, +$ fares). Touches the DOM only on change.
import { h, uiLayer, injectCss, esc, HAS_DOM } from './util.js';

const CSS = `
.bcm-mhud { position: absolute; inset: 0; pointer-events: none; z-index: 2; font-family: var(--font); color: #fff; }
.bcm-track { position: absolute; left: 50%; top: calc(16px + env(safe-area-inset-top, 0px) + 58px * var(--s, 1));
  transform: translateX(-50%) scale(var(--s, 1)); transform-origin: 50% 0; min-width: 240px; max-width: 340px;
  padding: 8px 14px 10px; background: rgba(0,0,0,.6); border-radius: 4px; border-top: 3px solid var(--accent, #f5c518);
  box-shadow: 0 6px 18px rgba(0,0,0,.28); opacity: 0; transition: opacity .3s ease, transform .3s ease; }
.bcm-track.on { opacity: 1; }
.bcm-track.notimer { top: calc(16px + env(safe-area-inset-top, 0px)); }
.bcm-track .ttl { font: 800 11px/1.2 var(--font); letter-spacing: .18em; text-transform: uppercase; color: var(--accent, #f5c518); margin-bottom: 6px; }
.bcm-track .rw { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-top: 4px; }
.bcm-track .lb { font: 700 11px/1.2 var(--font); letter-spacing: .12em; text-transform: uppercase; color: #c9ced6; }
.bcm-track .vl { font: 800 18px/1 var(--font-display); letter-spacing: .03em; font-variant-numeric: tabular-nums; }
.bcm-track .pb { height: 5px; margin-top: 4px; border-radius: 3px; background: rgba(255,255,255,.14); overflow: hidden; }
.bcm-track .pb b { display: block; height: 100%; border-radius: 3px; background: var(--c, #f5c518); transition: width .35s ease; }
.bcm-track .pb.mark { position: relative; overflow: visible; }
.bcm-track .pb.mark::after { content: ''; position: absolute; top: -3px; bottom: -3px; left: var(--m, 100%); width: 2px; background: #fff; border-radius: 1px; }
.bcm-count { position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%); font: 900 150px/1 var(--font-display);
  color: #fff; text-shadow: 0 6px 0 rgba(0,0,0,.35), 0 0 40px rgba(0,0,0,.4); -webkit-text-stroke: 3px rgba(0,0,0,.6); opacity: 0; }
.bcm-count.go { color: #6ee36a; }
.bcm-count.anim { animation: bcm-count .9s cubic-bezier(.2,1.4,.4,1) both; }
@keyframes bcm-count { 0% { opacity: 0; transform: translate(-50%, -50%) scale(2.2); } 25% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  75% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -50%) scale(.85); } }
.bcm-flash { position: absolute; left: 50%; top: 27%; transform: translateX(-50%); padding: 6px 16px; border-radius: 4px; background: rgba(0,0,0,.55);
  font: 800 22px/1.15 var(--font-display); letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; opacity: 0; }
.bcm-flash.anim { animation: bcm-flash 2.1s ease both; }
@keyframes bcm-flash { 0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(.95); } 12% { opacity: 1; transform: translateX(-50%); }
  80% { opacity: 1; } 100% { opacity: 0; transform: translateX(-50%) translateY(-8px); } }
.bcm-hidden .bcm-mhud { display: none; }
`;

export class MissionHUD {
  constructor(game) {
    this.game = game;
    this.root = null;
    this._key = '';
    this._vis = false;
    this._timerOn = null;
  }

  _mount() {
    if (this.root || !HAS_DOM) return !!this.root;
    injectCss('mhud', CSS);
    this.root = h('div', 'bcm-mhud', uiLayer());
    this.track = h('div', 'bcm-track', this.root);
    this.count = h('div', 'bcm-count', this.root);
    this.flashEl = h('div', 'bcm-flash', this.root);
    return true;
  }

  /**
   * Tracker card. data = {title, rows: [{label, value, progress?: 0..1, mark?: 0..1, color?}]} | null.
   */
  setTracker(data) {
    if (!this._mount()) return;
    const key = data ? JSON.stringify(data) : '';
    if (key === this._key) return;
    this._key = key;
    if (!data) { this.track.classList.remove('on'); return; }
    let html = data.title ? '<div class="ttl">' + esc(data.title) + '</div>' : '';
    for (const r of data.rows || []) {
      html += '<div class="rw"><span class="lb">' + esc(r.label) + '</span><span class="vl"' + (r.color ? ' style="color:' + esc(r.color) + '"' : '') + '>' + esc(r.value) + '</span></div>';
      if (Number.isFinite(r.progress)) {
        const pct = Math.max(0, Math.min(100, r.progress * 100));
        const mark = Number.isFinite(r.mark) ? ' mark" style="--m:' + Math.round(r.mark * 100) + '%' : '';
        html += '<div class="pb' + mark + '"><b style="width:' + pct.toFixed(1) + '%;--c:' + esc(r.color || '#f5c518') + '"></b></div>';
      }
    }
    this.track.innerHTML = html;
    this.track.classList.add('on');
  }

  /** Big centre countdown digit / word. */
  countdown(text, go = false) {
    if (!this._mount()) return;
    const c = this.count;
    c.textContent = String(text);
    c.classList.toggle('go', !!go);
    c.classList.remove('anim');
    void c.offsetWidth;
    c.classList.add('anim');
  }

  /** Short centre line (checkpoint split, fare paid...). */
  flash(text, color = '#ffffff') {
    if (!this._mount()) return;
    const f = this.flashEl;
    f.textContent = String(text);
    f.style.color = color;
    f.classList.remove('anim');
    void f.offsetWidth;
    f.classList.add('anim');
  }

  /** Per frame: hide with the HUD (pause / title), shift under the mission timer. */
  update() {
    if (!this.root) return;
    const g = this.game;
    const vis = g.state === 'playing' && !g.paused;
    if (vis !== this._vis) { this._vis = vis; this.root.style.display = vis ? '' : 'none'; }
    let timerOn = false;
    try { timerOn = !!(g.hud && typeof g.hud.timerRemaining === 'function' && g.hud.timerRemaining() !== null); } catch (e) { timerOn = false; }
    if (timerOn !== this._timerOn) { this._timerOn = timerOn; this.track.classList.toggle('notimer', !timerOn); }
  }

  clear() {
    this.setTracker(null);
  }
}
