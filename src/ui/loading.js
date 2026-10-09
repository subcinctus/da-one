// Loading screen: dark gradient with a drifting block grid, the blocky BLOCK CITY logo, a spinning grass block,
// a segmented progress bar with status text, and rotating gameplay tips.
import { el, injectStyles, uiRoot } from './styles.js';
import { createLogoCanvas, grassBlockTextures } from './logo.js';
import { richText } from './format.js';

export const TIPS = [
  'Mine ore for cash: coal, iron, gold and *diamond* pay out instantly. Dig deeper for the rare stuff.',
  'Press [F] next to any car to steal it. Pull the driver out if you have to.',
  'Break line of sight to lose the cops. Hide in alleys, tunnels or behind buildings until the stars stop flashing.',
  'TNT + bullets = chaos. Shoot a TNT block from a safe distance.',
  'Press [E] to open your inventory. In creative mode you get every block for free.',
  'Press [M] for the map. Click anywhere to set a GPS waypoint.',
  'The Pay \'n\' Spray clears your wanted level, for a price.',
  'Hold [RMB] to aim. Aimed shots are far more accurate.',
  'Hold [Shift] to sprint. [Space] in a car pulls the handbrake: drift!',
  'Buy guns and armor at the gun shop, building blocks and tools at the hardware store.',
  'The hospital patches you up when you are wasted, but it sends you the bill.',
  'Press [N] in a vehicle to cycle radio stations.',
  'Use the right tool: a pickaxe for stone, an axe for wood, a shovel for dirt and sand.',
  'Your safehouse saves the game and lets you sleep until morning.',
  'Press [C] to switch between first person, third person and the far camera.',
  'Helicopters fly with [Space] (up) and [Shift] (down). Find one on a helipad.',
  'Middle-click a block in creative mode to pick it into your hotbar.',
  'Look for yellow mission markers around the city: they pay well.',
];

export class LoadingScreen {
  constructor() {
    this.root = null;
    this.p = 0;
    this._tip = -1;
    this._tipT = 0;
    this._hidden = false;
  }

  _build() {
    injectStyles();
    const ui = uiRoot();
    const root = el('div', 'bc-load', ui);
    this.root = root;
    try {
      const w = Math.min(460, Math.round(window.innerWidth * 0.8));
      root.appendChild(createLogoCanvas(w));
    } catch (e) {
      el('h1', '', root, 'BLOCK CITY').style.cssText = 'font:400 64px var(--font-display);letter-spacing:.06em;margin:0';
    }
    const cubeWrap = el('div', 'bc-cube-wrap', root);
    const cube = el('div', 'bc-cube', cubeWrap);
    let tex = null;
    try { tex = grassBlockTextures(); } catch (e) { tex = null; }
    for (let i = 1; i <= 6; i++) {
      const f = el('b', 'f' + i, cube);
      if (tex) f.style.backgroundImage = `url(${i === 5 ? tex.top : i === 6 ? tex.bottom : tex.side})`;
      else f.style.background = i === 5 ? '#5d9b3a' : '#86603c';
    }
    const prog = el('div', 'bc-progress', root);
    const bar = el('div', 'bc-pbar', prog);
    this.fill = el('i', '', bar);
    const meta = el('div', 'bc-pmeta', prog);
    this.status = el('span', '', meta, 'Starting...');
    this.pct = el('b', '', meta, '0%');
    this.tip = el('div', 'bc-tip', root);
    this._nextTip(true);
  }

  _nextTip(first = false) {
    let i = Math.floor(Math.random() * TIPS.length);
    if (i === this._tip) i = (i + 1) % TIPS.length;
    this._tip = i;
    this._tipT = first ? 5 : 4.6;
    this.tip.innerHTML = '<span class="lbl">TIP</span>' + richText(TIPS[i]);
  }

  set(p, text) {
    if (this._hidden) return;
    if (!this.root) this._build();
    p = Math.max(0, Math.min(1, Number(p) || 0));
    if (p >= this.p - 0.001 || p === 0) this.p = Math.max(this.p, p);
    this.fill.style.width = (this.p * 100).toFixed(1) + '%';
    this.pct.textContent = Math.round(this.p * 100) + '%';
    if (text) this.status.textContent = String(text);
  }

  /** Rotate tips (called every frame while loading). */
  update(dt) {
    if (!this.root || this._hidden) return;
    this._tipT -= dt;
    if (this._tipT <= 0) {
      this.tip.classList.add('fade');
      this._tipT = 99;
      setTimeout(() => { if (!this._hidden) { this._nextTip(); this.tip.classList.remove('fade'); } }, 380);
    }
  }

  hide() {
    if (!this.root || this._hidden) { this._hidden = true; return; }
    this._hidden = true;
    this.set100();
    const r = this.root;
    r.classList.add('out');
    setTimeout(() => r.remove(), 800);
  }

  set100() {
    if (this.fill) { this.fill.style.width = '100%'; this.pct.textContent = '100%'; }
  }
}
