// Settings and controls screens.
import { Screen } from './screen.js';
import { h, esc, sfx } from './dom.js';
import { G, hint, glyph, keyList, keyCap } from './glyphs.js';

const PIXEL_RATIOS = [0.5, 0.67, 0.75, 1, 1.25, 1.5];

/** Settings rows: [key, label, kind, opts]. */
const ROWS = [
  ['volume', 'Master volume', 'slider', { min: 0, max: 1, step: 0.05 }],
  ['music', 'Music', 'slider', { min: 0, max: 1, step: 0.05 }],
  ['rumble', 'Controller rumble', 'toggle'],
  ['cameraSensitivity', 'Camera sensitivity', 'slider', { min: 0.3, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) + '×' }],
  ['invertY', 'Invert camera Y', 'toggle'],
  ['screenShake', 'Screen shake', 'toggle'],
  ['hitPause', 'Hit pause', 'toggle', { sub: 'Freeze a few frames on impact' }],
  ['shadows', 'Shadows', 'toggle'],
  ['pixelRatio', 'Resolution scale', 'cycle', { values: PIXEL_RATIOS, fmt: (v) => Math.round(v * 100) + '%', sub: 'Lower for speed, higher for sharpness' }],
  ['showFPS', 'Show FPS', 'toggle'],
];

export class SettingsScreen extends Screen {
  constructor(menus) { super(menus, { id: 'settings', uiId: null, hidesHud: true }); }

  render() {
    const el = h('div', 'ls-screen ls-dim');
    el.innerHTML = `<div class="ls-page"><header><div><div class="ls-kick">Options</div><h2 class="ls-h2">Settings</h2></div>
      <div class="right">Saved automatically</div></header><div class="body"><div class="ls-set"></div></div></div>
      <div class="ls-hintbar">${hint('navigate', 'Choose')}<span class="ls-hint">${G('left')}${G('right')}<span>Adjust</span></span>${hint('back', 'Back')}</div>`;
    const list = el.querySelector('.ls-set');
    this.rows = [];
    for (const [key, label, kind, o = {}] of ROWS) {
      const row = h('div', 'ls-row');
      row.dataset.nav = '';
      row.dataset.key = key;
      row.innerHTML = `<div class="l">${esc(label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div><div class="ls-val"></div>`;
      const val = row.querySelector('.ls-val');
      const draw = () => {
        const v = this.game.settings[key];
        if (kind === 'slider') {
          const t = (v - o.min) / (o.max - o.min);
          val.innerHTML = `<span class="arr">‹</span><div class="ls-slider"><i style="width:${(t * 100).toFixed(1)}%"></i><b style="left:${(t * 100).toFixed(1)}%"></b></div>` +
            `<span class="v" style="min-width:3.6em">${o.fmt ? o.fmt(v) : Math.round(v * 100)}</span><span class="arr">›</span>`;
        } else if (kind === 'toggle') {
          val.innerHTML = `<span class="arr">‹</span><span class="v">${v ? 'On' : 'Off'}</span><span class="arr">›</span>`;
        } else {
          val.innerHTML = `<span class="arr">‹</span><span class="v">${o.fmt ? o.fmt(v) : v}</span><span class="arr">›</span>`;
        }
      };
      const set = (v) => { this.game.settings[key] = v; draw(); this._save(); };
      row._adjust = (dir) => {
        const s = this.game.settings;
        if (kind === 'slider') set(Math.round(Math.max(o.min, Math.min(o.max, (+s[key] || 0) + dir * o.step)) * 100) / 100);
        else if (kind === 'toggle') set(!s[key]);
        else {
          const vals = o.values;
          let i = vals.indexOf(s[key]);
          if (i < 0) i = vals.indexOf(1);
          set(vals[Math.max(0, Math.min(vals.length - 1, i + dir))]);
        }
      };
      row._act = () => { if (kind === 'toggle') row._adjust(1); else if (kind === 'cycle') { const vals = o.values; const i = vals.indexOf(this.game.settings[key]); set(vals[(i + 1) % vals.length]); } };
      // mouse: click on the left/right halves of a slider adjusts
      val.addEventListener('click', (e) => {
        e.stopPropagation();
        this.nav.focus(row, true);
        if (kind === 'slider') {
          const r = val.querySelector('.ls-slider').getBoundingClientRect();
          const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
          if (e.clientX >= r.left - 8 && e.clientX <= r.right + 8) set(Math.round((o.min + t * (o.max - o.min)) / o.step) * o.step);
          else row._adjust(e.clientX < r.left ? -1 : 1);
        } else row._act();
        sfx(this.game, 'ui_move');
      });
      draw();
      list.appendChild(row);
      this.rows.push(row);
    }
    return el;
  }

  _save() {
    clearTimeout(this._saveT);
    // debounce the resize / shadow rebuild while a slider is held
    this._saveT = setTimeout(() => { try { this.game.saveSettings(); } catch (e) { console.error('[ui] saveSettings', e); } }, 120);
  }

  back() {
    clearTimeout(this._saveT);
    try { this.game.saveSettings(); } catch (e) { console.error('[ui] saveSettings', e); }
    sfx(this.game, 'ui_back');
    this.close(null);
  }
}

// ================================================================================================ controls

/** Action list (FIGHTER.md §3). side: which side of the pad diagram. */
const ACTIONS = [
  ['focus', 'Focus attack', 'Spend focus: with main = strike, with alternate = sweep', 'l'],
  ['lock', 'Lock on', 'Toggle lock-on', 'l'],
  ['move', 'Move', 'Strafe around your target when locked', 'l'],
  ['deck', 'Combat deck', 'At rest points only', 'l'],
  ['pause', 'Pause', '', 'l'],
  ['stanceFlick', 'Change stance', 'Hold and flick to a quadrant', 'r'],
  ['guard', 'Guard', 'Hold to block · tap during your startup to feint', 'r'],
  ['heavy', 'Alternate attack', 'Current stance\'s alternate slot', 'r'],
  ['light', 'Main attack', 'Current stance\'s main slot · chains into the next stance', 'r'],
  ['defend', 'Style ability', 'Parry, absorb or avoid', 'r'],
  ['dodge', 'Dodge', 'In the stick direction, back-step when neutral', 'r'],
  ['target', 'Switch target', 'Or flick the right stick while locked', 'r'],
  ['camera', 'Camera', '', 'r'],
];

const PAD_SVG = `<svg class="ls-pad" viewBox="0 0 300 200" fill="none" stroke="currentColor" stroke-width="1.6">
  <path d="M78 46 C58 46 42 58 36 80 L16 150 C10 176 30 192 50 180 L84 150 C90 144 98 142 106 142 L194 142 C202 142 210 144 216 150 L250 180 C270 192 290 176 284 150 L264 80 C258 58 242 46 222 46 Z" />
  <path d="M70 40 C74 30 86 28 100 30 L104 40 M230 40 C226 30 214 28 200 30 L196 40" opacity=".7"/>
  <circle cx="92" cy="92" r="16"/><circle cx="92" cy="92" r="9" opacity=".5"/>
  <circle cx="184" cy="126" r="16"/><circle cx="184" cy="126" r="9" opacity=".5"/>
  <path d="M110 116 h10 v-10 h10 v10 h10 v10 h-10 v10 h-10 v-10 h-10 z" opacity=".85"/>
  <circle cx="226" cy="76" r="7"/><circle cx="242" cy="92" r="7"/><circle cx="210" cy="92" r="7"/><circle cx="226" cy="108" r="7"/>
  <rect x="132" y="80" width="12" height="7" rx="3" opacity=".7"/><rect x="156" y="80" width="12" height="7" rx="3" opacity=".7"/>
</svg>`;

export class ControlsScreen extends Screen {
  constructor(menus) {
    super(menus, { id: 'controls', uiId: null, hidesHud: true });
    this.tab = this.game.input && this.game.input.padType ? 'pad' : 'keys';
  }

  render() {
    const el = h('div', 'ls-screen ls-dim');
    el.innerHTML = `<div class="ls-page"><header><div><div class="ls-kick">Reference</div><h2 class="ls-h2">Controls</h2></div>
      <div class="ls-tabs">${G('tabPrev')}<span class="ls-tab" data-action="tab:pad">Controller</span><span class="ls-tab" data-action="tab:keys">Keyboard &amp; mouse</span>${G('tabNext')}</div>
      </header><div class="body"></div></div>
      <div class="ls-hintbar">${hint('back', 'Back')}</div>`;
    this.$body = el.querySelector('.body');
    this.$tabs = el.querySelectorAll('.ls-tab');
    this._draw(el);
    return el;
  }

  _draw(el = this.el) {
    for (const t of this.$tabs) t.classList.toggle('on', t.dataset.action === 'tab:' + this.tab);
    const pad = this.game.input && this.game.input.padType;
    if (this.tab === 'pad') {
      const pt = pad || 'xbox';
      const col = (side) => ACTIONS.filter((a) => a[3] === side).map(([act, name, desc]) =>
        `<div class="it"><span class="ls-gw">${glyph(act, pt)}</span><div><span class="a">${esc(name)}</span>${desc ? `<span class="d">${esc(desc)}</span>` : ''}</div></div>`).join('');
      this.$body.innerHTML = `<div class="ls-ctl"><div class="col l">${col('l')}</div><div>${PAD_SVG}</div><div class="col r">${col('r')}</div></div>`;
    } else {
      const rows = ACTIONS.map(([act, name, desc]) => {
        let keys;
        if (act === 'move') keys = glyph('move', null);
        else if (act === 'camera') keys = '<span class="ls-g ls-g-key wide">Mouse</span>';
        else if (act === 'stanceFlick') keys = glyph('stanceFlick', null);
        else keys = keyList(act);
        return `<div class="it"><div><span class="a">${esc(name)}</span>${desc ? `<span class="d">${esc(desc)}</span>` : ''}</div><div class="ls-gw">${keys}</div></div>`;
      }).join('') + `<div class="it"><div><span class="a">Menus</span><span class="d">Navigate, confirm, back</span></div><div class="ls-gw">${keyCap('ArrowUp')}${keyCap('ArrowDown')}${keyCap('Enter')}${keyCap('Escape')}</div></div>`;
      this.$body.innerHTML = `<div class="ls-keys">${rows}</div>`;
    }
    if (el) this.refreshGlyphs();
  }

  onAction(a) {
    if (a === 'tabPrev' || a === 'tabNext' || a === 'tab:pad' || a === 'tab:keys') {
      this.tab = a === 'tab:pad' ? 'pad' : a === 'tab:keys' ? 'keys' : this.tab === 'pad' ? 'keys' : 'pad';
      sfx(this.game, 'ui_move');
      this._draw();
      return true;
    }
    if (a === 'back' || a === 'confirm') { sfx(this.game, 'ui_back'); this.close(null); return true; }
    return false;
  }

  onDir(d) { if (d === 'left' || d === 'right') return this.onAction(d === 'left' ? 'tabPrev' : 'tabNext'); return false; }
}
