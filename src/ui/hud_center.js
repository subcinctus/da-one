// Centre-screen HUD: crosshair (dot + 4 lines with bloom from firing / movement, red over hostile targets),
// hit marker (white X, red on kill), mining progress ring, directional damage arcs; plus full-screen effects:
// red damage vignette with low-health pulse, sniper scope, and the WASTED / BUSTED canvas desaturation.
import * as THREE from 'three';
import { el } from './styles.js';
import { WEAPONS } from '../data/weapons.js';

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;
const _ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };

export class Crosshair {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.bloom = 0;
    this._gap = -1;
    this._vis = null;
    this._lines = null;
    this._enemy = false;
    this._enemyT = 0;
    this._ring = -1;
    this._ringOn = false;
    this.dirs = [];
    this._dirIdx = 0;
  }

  mount(parent) {
    this.center = el('div', 'bc-center', parent);
    this.ringEl = el('div', 'bc-ring', this.center);
    this.ringEl.innerHTML = `<svg viewBox="0 0 52 52"><circle class="bg" cx="26" cy="26" r="${RING_R}"/>` +
      `<circle class="fg" cx="26" cy="26" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"/></svg>`;
    this.ringFg = this.ringEl.querySelector('.fg');
    this.xh = el('div', 'bc-xh', this.center);
    el('i', 'dot', this.xh);
    this.lt = el('i', 'ln', this.xh);
    this.lb = el('i', 'ln', this.xh);
    this.ll = el('i', 'ln h', this.xh);
    this.lr = el('i', 'ln h', this.xh);
    this.hit = el('div', 'bc-hit', this.center);
    for (let i = 0; i < 4; i++) {
      const l = el('i', '', this.hit);
      const a = 45 + i * 90;
      l.style.transform = `rotate(${a}deg) translateY(-11px)`;
    }
    for (let i = 0; i < 4; i++) this.dirs.push(el('div', 'bc-dmgdir', this.center));
  }

  /** weaponFired by the player: kick the crosshair open. */
  kick(weaponId) {
    const def = WEAPONS[weaponId];
    const k = def ? (def.kind === 'hitscan' ? 4 + (def.spread || 0.02) * 160 + (def.pellets ? 6 : 0) : 6) : 5;
    this.bloom = Math.min(26, this.bloom + k);
  }

  /** Flash the hit marker; red when the hit killed. */
  hitMarker(killed = false) {
    const h = this.hit;
    h.classList.toggle('kill', !!killed);
    if (h.animate) {
      h.animate([
        { opacity: 1, transform: `scale(${killed ? 1.5 : 1.3})` },
        { opacity: 1, transform: 'scale(1)', offset: 0.55 },
        { opacity: 0, transform: 'scale(1)' },
      ], { duration: killed ? 420 : 300, easing: 'ease-out' });
    } else {
      h.classList.remove('on'); void h.offsetWidth; h.classList.add('on');
    }
  }

  /** Red arc pointing at where the damage came from (screen angle, 0 = ahead). */
  damageFrom(angle, strength = 1) {
    const d = this.dirs[this._dirIdx++ % this.dirs.length];
    d.style.transform = `rotate(${angle}rad)`;
    if (d.animate) {
      d.animate([{ opacity: Math.min(1, 0.55 + strength * 0.45) }, { opacity: 0 }], { duration: 1300, easing: 'ease-in' });
    }
  }

  update(dt, visible) {
    const g = this.game;
    const p = g.player;
    const cam = g.cameraRig;
    const inv = g.inventory;
    const item = inv && inv.getSelected ? inv.getSelected() : null;
    const def = item && item.kind === 'weapon' ? WEAPONS[item.id] : null;
    const inVeh = !!(p && p.inVehicle);
    const aiming = !!(p && p.aiming);
    const scoped = !!(cam && cam.scoped);
    const vis = visible && !!p && p.alive !== false && !p.handsUp && !scoped && (!inVeh || aiming);
    if (vis !== this._vis) { this._vis = vis; this.xh.classList.toggle('hide', !vis); }

    this.bloom *= Math.exp(-dt * 7);
    if (this.bloom < 0.05) this.bloom = 0;

    // mining progress ring
    const mp = this.hud.miningProgress;
    const ringOn = visible && mp !== null && mp !== undefined && Number.isFinite(mp) && mp > 0;
    if (ringOn !== this._ringOn) { this._ringOn = ringOn; this.ringEl.classList.toggle('on', ringOn); }
    if (ringOn) {
      const r = Math.round(Math.min(1, mp) * 200) / 200;
      if (r !== this._ring) { this._ring = r; this.ringFg.setAttribute('stroke-dashoffset', (RING_C * (1 - r)).toFixed(2)); }
    }
    if (!vis) return;

    const gun = !!(def && (def.kind === 'hitscan' || def.kind === 'projectile'));
    if (gun !== this._lines) { this._lines = gun; this.xh.classList.toggle('nolines', !gun); }
    if (gun) {
      let gap = 4 + (def.spread || 0.01) * 170 + (def.pellets ? 4 : 0);
      if (aiming) gap *= 0.62;
      const v = p.velocity;
      const sp = v ? Math.hypot(v.x, v.z) : 0;
      gap += Math.min(9, sp * 1.1) + (p.onGround === false && !inVeh ? 5 : 0) + this.bloom;
      gap = Math.round(gap * 2) / 2;
      if (gap !== this._gap) {
        this._gap = gap;
        this.lt.style.transform = `translateY(${-gap - 4}px)`;
        this.lb.style.transform = `translateY(${gap + 4}px)`;
        this.ll.style.transform = `translateX(${-gap - 4}px)`;
        this.lr.style.transform = `translateX(${gap + 4}px)`;
      }
    }

    // target check (~12 Hz): red reticle over hostile / living humanoids within range
    this._enemyT -= dt;
    if (this._enemyT <= 0) {
      this._enemyT = 0.08;
      let enemy = false;
      if (def && def.kind !== 'throw' && cam && cam.getAimRay && g.entities && g.entities.raycast) {
        try {
          cam.getAimRay(_ray);
          const range = Math.min(def.range || 60, 160);
          const hit = g.entities.raycast(_ray.origin, _ray.dir, range, p);
          const e = hit && hit.entity;
          enemy = !!(e && e !== p && e.alive !== false && (e.team === 'police' || e.team === 'gang' || e.kind === 'ped' || e.kind === 'cop'));
        } catch (err) { enemy = false; }
      }
      if (enemy !== this._enemy) { this._enemy = enemy; this.xh.classList.toggle('enemy', enemy); }
    }
  }
}

export class ScreenFX {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.flash = 0;
    this._op = -1;
    this._scope = null;
    this._filter = '';
    this.filterT = 0;
  }

  mount(parent) {
    this.vig = el('div', 'bc-vig', parent);
    this.scope = el('div', 'bc-scope', parent);
    el('i', '', this.scope);
  }

  /** Red damage flash (0..1). */
  damage(intensity = 0.5) {
    const i = Math.max(0.1, Math.min(1, Number(intensity) || 0.5));
    this.flash = Math.min(1, Math.max(this.flash, i * 0.9));
  }

  /** CSS filter on the 3D canvas for `seconds` (WASTED / BUSTED look). */
  setFilter(css, seconds) {
    const c = this.game.renderer && this.game.renderer.domElement;
    if (!c) return;
    if (this._filter !== css) {
      this._filter = css;
      c.style.transition = 'filter 1.1s ease';
      c.style.filter = css;
    }
    this.filterT = seconds;
  }

  clearFilter() {
    const c = this.game.renderer && this.game.renderer.domElement;
    this.filterT = 0;
    if (!c || !this._filter) return;
    this._filter = '';
    c.style.transition = 'filter .8s ease';
    c.style.filter = '';
  }

  update(dt, visible) {
    const g = this.game;
    const p = g.player;
    this.flash = Math.max(0, this.flash - dt * 1.5);
    let op = this.flash;
    if (visible && p && p.alive !== false) {
      const hp = (Number(p.health) || 0) / (p.maxHealth || 100);
      if (hp < 0.3) {
        const k = 1 - hp / 0.3;
        op = Math.max(op, (0.3 + 0.22 * Math.sin((g.realTime || 0) * (4 + 3 * k))) * (0.45 + 0.55 * k));
      }
    }
    if (!visible) op = 0;
    op = Math.round(op * 50) / 50;
    if (op !== this._op) { this._op = op; this.vig.style.opacity = String(op); }
    const scoped = visible && !!(g.cameraRig && g.cameraRig.scoped) && !!(p && p.alive !== false);
    if (scoped !== this._scope) { this._scope = scoped; this.scope.classList.toggle('on', scoped); }
    if (this.filterT > 0) {
      this.filterT -= dt;
      if (this.filterT <= 0) this.clearFilter();
    }
  }
}
