// HUD status widgets: top-right cluster (clock, weapon + ammo, wanted stars, money with animated delta),
// vitals under the radar (health / armor with damage chip, breath bubbles) and the in-vehicle speedometer.
// All widgets cache what they last wrote and touch the DOM only when a value changes.
import { el } from './styles.js';
import { STAR_SVG, setIcon } from './icons.js';
import { formatMoney, formatDelta, formatClock, toKmh, clamp01 } from './format.js';
import { WEAPONS } from '../data/weapons.js';

export class TopRight {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.money = null;      // displayed (animated) money
    this.moneyTarget = 0;
    this._moneyTxt = '';
    this._delta = 0;
    this._deltaT = 0;
    this._wanted = -1;
    this._search = null;
    this._zeroT = 0;
    this._clockTxt = '';
    this._night = null;
    this._wKey = null;
    this._ammoTxt = null;
    this._rlTxt = null;
  }

  mount(parent) {
    this.clock = el('div', 'bc-clock', parent);
    el('span', 'sun', this.clock);
    this.clockTxt = el('span', '', this.clock, '09:00');
    this.weapon = el('div', 'bc-weapon hide', parent);
    const ammoBox = el('div', '', this.weapon);
    this.ammo = el('div', 'ammo', ammoBox);
    this.rl = el('span', 'rl', ammoBox);
    this.wIco = el('div', 'ico', this.weapon);
    this.stars = el('div', 'bc-stars zero', parent);
    this.starEls = [];
    for (let i = 0; i < 5; i++) {
      const s = el('div', 'bc-star', this.stars);
      s.innerHTML = STAR_SVG;
      this.starEls.push(s);
    }
    this.moneyEl = el('div', 'bc-money', parent, '$0');
    this.deltaEl = el('div', 'bc-delta', parent);
  }

  /** moneyChanged handler: accumulate the +/- popup. */
  onMoney(e) {
    if (!e || !Number.isFinite(e.delta) || e.delta === 0) return;
    if (e.reason === 'load' || this.game.state !== 'playing') return;
    if (this._deltaT <= 0) this._delta = 0;
    this._delta += e.delta;
    this._deltaT = 2.6;
    this.deltaEl.textContent = formatDelta(this._delta);
    this.deltaEl.className = 'bc-delta on ' + (this._delta >= 0 ? 'pos' : 'neg');
    if (this.moneyEl.animate) {
      this.moneyEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)', offset: 0.3 }, { transform: 'scale(1)' }],
        { duration: 400, easing: 'ease-out' });
    }
  }

  update(dt) {
    const g = this.game;
    const p = g.player;
    // money (animated count)
    const target = p && Number.isFinite(p.money) ? p.money : 0;
    if (this.money === null || g.state !== 'playing') this.money = target;
    else if (this.money !== target) {
      const diff = target - this.money;
      const step = diff * Math.min(1, dt * 7);
      this.money += Math.abs(step) < 1 ? Math.sign(diff) * Math.min(Math.abs(diff), 1) : step;
      if (Math.abs(target - this.money) < 0.5) this.money = target;
    }
    const mi = Math.round(this.money);
    if (mi !== this._moneyInt) {
      this._moneyInt = mi;
      const txt = formatMoney(mi);
      if (txt !== this._moneyTxt) { this._moneyTxt = txt; this.moneyEl.textContent = txt; }
    }
    if (this._deltaT > 0) {
      this._deltaT -= dt;
      if (this._deltaT <= 0) this.deltaEl.classList.remove('on');
    }

    // wanted stars
    const police = g.police;
    const wanted = Math.max(0, Math.min(5, (police && police.wanted) | 0));
    if (wanted !== this._wanted) {
      const prev = this._wanted;
      this._wanted = wanted;
      for (let i = 0; i < 5; i++) {
        const s = this.starEls[i];
        const on = i < wanted;
        s.classList.toggle('on', on);
        // flash every filled star when the level changes (and the lost ones when dropping to 0)
        if (prev >= 0 && (on || wanted === 0) && s.animate) {
          if (s.__flash) s.__flash.cancel();
          s.__flash = s.animate([
            { transform: 'scale(1.3)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.2, offset: 0.5 }, { transform: 'scale(1)', opacity: 1 },
          ], { duration: 360, iterations: 4, easing: 'steps(2, jump-none)' });
        }
      }
      if (wanted > 0) { this.stars.classList.remove('zero'); this._zeroT = 0; } else this._zeroT = prev > 0 ? 1.8 : 0.01;
    }
    if (this._zeroT > 0) {
      this._zeroT -= dt;
      if (this._zeroT <= 0) this.stars.classList.add('zero');
    }
    const searching = wanted > 0 && !!(police && (police.searching || police.isSearching));
    if (searching !== this._search) { this._search = searching; this.stars.classList.toggle('search', searching); }

    // clock
    const sky = g.sky;
    if (sky && Number.isFinite(sky.time)) {
      const c = formatClock(sky.time);
      if (c !== this._clockTxt) { this._clockTxt = c; this.clockTxt.textContent = c; }
      const night = (sky.nightFactor || 0) > 0.5;
      if (night !== this._night) { this._night = night; this.clock.classList.toggle('night', night); }
    }

    // weapon + ammo
    const inv = g.inventory;
    const item = inv && inv.getSelected ? inv.getSelected() : null;
    const isWeapon = !!(item && item.kind === 'weapon' && WEAPONS[item.id]);
    const key = isWeapon ? item.id : '';
    if (key !== this._wKey) {
      this._wKey = key;
      this.weapon.classList.toggle('hide', !isWeapon);
      if (isWeapon) setIcon(this.wIco, item, g.world);
      this._ammoTxt = null;
    }
    if (isWeapon) {
      const def = WEAPONS[item.id];
      let at = '';
      if (def.mag > 0) at = (item.mag | 0) + '|' + (item.reserve | 0);
      if (at !== this._ammoTxt) {
        this._ammoTxt = at;
        if (def.mag > 0) {
          this.ammo.innerHTML = '<span class="mag">' + (item.mag | 0) + '</span> <span class="res">/ ' + (item.reserve | 0) + '</span>';
          this.ammo.classList.toggle('empty', (item.mag | 0) === 0);
        } else this.ammo.textContent = '';
      }
      const c = g.combat;
      const reloading = !!(c && (c.reloading || (typeof c.isReloading === 'function' && c.isReloading()) || c.reloadT > 0 || item.reloading));
      const rl = reloading ? 'RELOADING' : ((def.mag > 0 && (item.mag | 0) === 0 && (item.reserve | 0) > 0) ? 'PRESS R' : '');
      if (rl !== this._rlTxt) { this._rlTxt = rl; this.rl.textContent = rl; }
    }
  }
}

/** Health / armor bars + breath bubbles (under the radar). */
export class Vitals {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this._hp = -1; this._ar = -1; this._low = null; this._dead = null; this._breath = -1;
  }

  mount(parent) {
    const bars = el('div', 'bc-bars', parent);
    this.hpBar = el('div', 'bc-bar hp', bars);
    this.hpChip = el('i', 'chip', this.hpBar);
    this.hpFill = el('i', 'fill', this.hpBar);
    this.arBar = el('div', 'bc-bar ar', bars);
    this.arChip = el('i', 'chip', this.arBar);
    this.arFill = el('i', 'fill', this.arBar);
    this.breath = el('div', 'bc-breath hide', parent);
    this.bubbles = [];
    for (let i = 0; i < 10; i++) this.bubbles.push(el('b', '', this.breath));
  }

  update() {
    const p = this.game.player;
    if (!p) return;
    const hp = clamp01((Number(p.health) || 0) / (p.maxHealth || 100));
    const ar = clamp01((Number(p.armor) || 0) / (p.maxArmor || 100));
    const hpR = Math.round(hp * 400) / 400, arR = Math.round(ar * 400) / 400;
    if (hpR !== this._hp) {
      this._hp = hpR;
      this.hpFill.style.transform = 'scaleX(' + hpR + ')';
      this.hpChip.style.transform = 'scaleX(' + hpR + ')';
    }
    if (arR !== this._ar) {
      this._ar = arR;
      this.arFill.style.transform = 'scaleX(' + arR + ')';
      this.arChip.style.transform = 'scaleX(' + arR + ')';
    }
    const dead = p.alive === false;
    const low = !dead && hp < 0.25;
    if (low !== this._low) { this._low = low; this.hpBar.classList.toggle('low', low); }
    if (dead !== this._dead) { this._dead = dead; this.hpBar.classList.toggle('dead', dead); }
    const br = Number.isFinite(p.breath) ? p.breath : 1;
    const n = br >= 0.999 ? -1 : Math.ceil(br * 10);
    if (n !== this._breath) {
      this._breath = n;
      this.breath.classList.toggle('hide', n < 0);
      for (let i = 0; i < 10; i++) this.bubbles[i].classList.toggle('pop', n >= 0 && i >= n);
    }
  }
}

const GAUGE_START = 225, GAUGE_SWEEP = 270, GR = 54;
const polar = (a, r) => { const t = (a - 90) * Math.PI / 180; return [66 + r * Math.cos(t), 66 + r * Math.sin(t)]; };

/** Speedometer (bottom-right, in vehicles). */
export class Speedo {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this._on = false;
    this._kmh = -1;
    this._frac = -1;
    this._cls = '';
    this._alt = null;
    this._vhp = -1;
    this._vcls = '';
    this._max = 0;
  }

  mount(parent) {
    this.root = el('div', 'bc-speedo', parent);
    const [x0, y0] = polar(GAUGE_START, GR);
    const [x1, y1] = polar(GAUGE_START + GAUGE_SWEEP, GR);
    const arcD = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${GR} ${GR} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    this.arcLen = (Math.PI * 2 * GR * GAUGE_SWEEP) / 360;
    let ticks = '';
    for (let i = 0; i <= 10; i++) {
      const a = GAUGE_START + (GAUGE_SWEEP * i) / 10;
      const [ax, ay] = polar(a, GR + 9), [bx, by] = polar(a, GR + (i % 5 === 0 ? 15 : 12));
      ticks += `<line class="tick" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
    }
    this.root.innerHTML = `<svg viewBox="0 0 132 132"><circle class="face" cx="66" cy="66" r="49"/>${ticks}` +
      `<path class="trk" d="${arcD}"/><path class="arc" d="${arcD}" stroke-dasharray="${this.arcLen.toFixed(1)} 999" stroke-dashoffset="${this.arcLen.toFixed(1)}"/></svg>` +
      '<div class="num">0</div><div class="unit">KM/H</div><div class="alt"></div><div class="vhp"><i></i></div>';
    this.arc = this.root.querySelector('.arc');
    this.num = this.root.querySelector('.num');
    this.altEl = this.root.querySelector('.alt');
    this.vhp = this.root.querySelector('.vhp');
    this.vhpFill = this.vhp.firstChild;
  }

  update(dt, speedOverride) {
    const g = this.game;
    const p = g.player;
    const veh = (p && p.inVehicle) || (g.vehicles && g.vehicles.playerVehicle) || null;
    const on = !!veh && g.state === 'playing' && !!(p && p.alive !== false);
    if (on !== this._on) { this._on = on; this.root.classList.toggle('on', on); }
    if (!on) return;
    const kmh = speedOverride !== null && Number.isFinite(speedOverride) ? Math.round(Math.abs(speedOverride)) : toKmh(veh.speed);
    if (kmh !== this._kmh) { this._kmh = kmh; this.num.textContent = String(kmh); }
    const top = veh.def && veh.def.maxSpeed > 0 ? veh.def.maxSpeed * 3.6 * 1.08 : 220;
    if (top !== this._max) this._max = top;
    const frac = Math.round(clamp01(kmh / top) * 200) / 200;
    if (frac !== this._frac) {
      this._frac = frac;
      this.arc.setAttribute('stroke-dashoffset', (this.arcLen * (1 - frac)).toFixed(1));
      const cls = frac > 0.92 ? 'arc max' : frac > 0.7 ? 'arc fast' : 'arc';
      if (cls !== this._cls) { this._cls = cls; this.arc.setAttribute('class', cls); }
    }
    // helicopter altitude
    const heli = (veh.def && veh.def.kind === 'heli') || veh.kind === 'heli';
    let alt = '';
    if (heli && veh.position) {
      let ground = 28;
      try { ground = g.generator?.plan?.surfaceY?.(veh.position.x, veh.position.z) ?? 28; } catch (e) { ground = 28; }
      alt = 'ALT ' + Math.max(0, Math.round(veh.position.y - ground)) + ' m';
    }
    if (alt !== this._alt) { this._alt = alt; this.altEl.textContent = alt; }
    // vehicle health
    const vh = veh.maxHealth > 0 ? clamp01(veh.health / veh.maxHealth) : 1;
    const vhr = Math.round(vh * 100) / 100;
    if (vhr !== this._vhp) {
      this._vhp = vhr;
      this.vhpFill.style.transform = 'scaleX(' + vhr + ')';
      const c = vhr < 0.2 ? 'vhp crit' : vhr < 0.45 ? 'vhp warn' : 'vhp';
      if (c !== this._vcls) { this._vcls = c; this.vhp.className = c; }
    }
  }
}
