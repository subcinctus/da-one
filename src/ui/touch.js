// Touch controls (see ARCHITECTURE.md §Touch): enabled on coarse pointers, with ?touch=1, or on the first real
// touch (?touch=0 disables). Left: a floating virtual joystick (push fully to sprint). Right half: drag to look.
// Buttons: attack (hold, also drags the view), aim / place, jump (handbrake in cars), F, reload / horn, camera,
// inventory, map, radio, pause. The HUD switches to its touch layout (radar top-left, tappable hotbar).
import { el, injectStyles, uiRoot } from './styles.js';

const LOOK_GAIN = 2.3;      // touch px -> mouse px (input applies the sensitivity setting)
const STICK_R = 56;         // knob travel (px)
const DEAD = 0.12;

const ICONS = {
  attack: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  aim: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  reload: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  inventory: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  horn: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l6 5V4L8 9z"/><path d="M18 8a5 5 0 0 1 0 8"/></svg>',
  radio: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
};

/**
 * Button table. pos = centre offset from the bottom-right corner [right, bottom] (px, scaled by --ts) or
 * from the top-right [right, top] for 'top' buttons. ctx: 'foot' | 'car' | 'any'.
 */
const BUTTONS = [
  { id: 'attack', action: 'attack', label: 'ATK', icon: 'attack', size: 'big', pos: [84, 176], land: [84, 150], look: true, ctx: 'any' },
  { id: 'jump', action: 'jump', label: 'JUMP', carLabel: 'BRAKE', icon: 'jump', pos: [186, 112], land: [192, 92], ctx: 'any' },
  { id: 'aim', action: 'aim', label: 'AIM', icon: 'aim', pos: [190, 222], land: [198, 196], look: true, ctx: 'any' },
  { id: 'enter', action: 'enterVehicle', label: 'F', pos: [96, 290], land: [92, 256], ctx: 'any' },
  { id: 'reload', action: 'reload', label: 'R', icon: 'reload', size: 'sm', pos: [196, 312], land: [290, 118], ctx: 'foot' },
  { id: 'horn', action: 'horn', label: 'HORN', icon: 'horn', size: 'sm', pos: [196, 312], land: [290, 118], ctx: 'car' },
  { id: 'radio', action: 'radio', label: 'RADIO', icon: 'radio', size: 'sm', pos: [34, 56], top: true, ctx: 'car' },
  { id: 'camera', action: 'camera', label: 'CAM', icon: 'camera', size: 'sm', pos: [34, 0], top: true, ctx: 'any' },
  { id: 'inventory', action: 'inventory', label: 'INV', icon: 'inventory', size: 'sm', pos: [34, 56], top: true, ctx: 'foot' },
  { id: 'map', action: 'map', label: 'MAP', icon: 'map', size: 'sm', pos: [34, 112], top: true, ctx: 'any' },
  { id: 'pause', action: 'pause', label: 'II', icon: 'pause', size: 'sm', pos: [34, 168], top: true, ctx: 'any' },
];

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.enabled = false;
    this.root = null;
    this.buttons = new Map();
    this._stick = null;     // {id, ox, oy}
    this._look = new Map(); // pointerId -> {x, y}
    this._axis = { x: 0, y: 0 };
    this._sprint = false;
    this._vis = null;
    this._ctx = null;
    this._topOffset = 0;
  }

  init() {
    const g = this.game;
    const param = g.params ? g.params.get('touch') : null;
    if (param === '0') return;
    let coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { coarse = false; }
    if (param === '1' || coarse) this.enable();
    else {
      window.addEventListener('touchstart', () => { if (!this.enabled) this.enable(); }, { once: true, passive: true });
    }
    g.events.on('uiChanged', () => this.releaseAll());
    g.events.on('pauseChanged', () => this.releaseAll());
    if (g.debug) g.debug.touch = this;
  }

  /** Build the controls and switch the HUD to the touch layout. */
  enable() {
    if (this.enabled) return;
    injectStyles();
    this.enabled = true;
    const root = el('div', 'bc-touch off', uiRoot());
    this.root = root;
    const look = el('div', 'look', root);
    this._bindLook(look);
    const zone = el('div', 'stick-zone', root);
    this.stick = el('div', 'stick', root);
    this.knob = el('div', 'knob', this.stick);
    this._bindStick(zone);
    for (const b of BUTTONS) this._makeButton(b);
    // Pointer lock makes no sense with touch: release it and stop requesting it (a granted lock would route every
    // pointer event to the canvas). Losing the lock then also no longer pauses the game.
    const input = this.game.input;
    if (input) { try { input.exitLock?.(); } catch (e) { /* ignore */ } input.lockFailed = true; }
    this.game.hud?.setTouchMode?.(true);
    this.onResize(window.innerWidth, window.innerHeight);
  }

  _ts() {
    const w = window.innerWidth, h = window.innerHeight;
    return Math.max(0.78, Math.min(1.25, Math.min(w, h) / 420));
  }

  onResize(w, h) {
    if (!this.root) return;
    w = w || window.innerWidth; h = h || window.innerHeight;
    const ts = this._ts();
    this.ts = ts;
    // keep the hotbar row free (it sits on top of the touch layer)
    const hudScale = this.game.hud?.scale || 1;
    const hot = Math.round(66 * hudScale + 14);
    this._hot = hot;
    const landscape = w > h;
    for (const [, rec] of this.buttons) {
      const [r, v] = landscape && rec.def.land ? rec.def.land : rec.def.pos;
      const size = rec.def.size === 'big' ? 86 : rec.def.size === 'sm' ? 46 : 64;
      rec.el.style.transform = `scale(${ts})`;
      rec.el.style.width = rec.el.style.height = size + 'px';
      if (rec.def.top) {
        const idx = Math.round(v / 56);
        if (!landscape) {
          // portrait: a column on the right edge below the money / wanted cluster
          rec.el.style.left = `calc(100% - ${Math.round(r * ts) + 6}px - env(safe-area-inset-right, 0px))`;
          rec.el.style.top = `calc(${Math.round(idx * 56 * ts + this._topBase(h, ts))}px + env(safe-area-inset-top, 0px))`;
        } else {
          // landscape: a row along the top, left of the money / wanted cluster
          const right = Math.round(200 * hudScale + 40 + idx * 56 * ts);
          rec.el.style.left = `calc(100% - ${right}px - env(safe-area-inset-right, 0px))`;
          rec.el.style.top = `calc(${Math.round(34 * ts)}px + env(safe-area-inset-top, 0px))`;
        }
      } else {
        rec.el.style.left = `calc(100% - ${Math.round(r * ts)}px - env(safe-area-inset-right, 0px))`;
        rec.el.style.top = `calc(100% - ${Math.round(v * ts + hot * 0.35)}px - env(safe-area-inset-bottom, 0px))`;
      }
    }
    // stick rests bottom-left above the hotbar
    this._rest = { x: Math.round(104 * ts) + 8, y: h - Math.round(150 * ts) - hot * 0.35 };
    if (!this._stick) this._placeStick(this._rest.x, this._rest.y, 0, 0);
    const zone = this.root.querySelector('.stick-zone');
    if (zone) zone.style.bottom = hot + 'px';
  }

  /** Top-right small buttons start below the HUD's top-right cluster. */
  _topBase(h, ts) {
    const s = this.game.hud?.scale || 1;
    return Math.max(Math.round(h * 0.3), Math.round(215 * s + 30 * ts));
  }

  _makeButton(def) {
    const b = el('div', 'bc-tb' + (def.size ? ' ' + def.size : ''), this.root);
    b.innerHTML = def.icon ? ICONS[def.icon] : '';
    if (!def.icon) b.textContent = def.label;
    b.setAttribute('aria-label', def.label);
    const rec = { def, el: b, pid: null, lx: 0, ly: 0 };
    this.buttons.set(def.id, rec);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (rec.pid !== null) return;
      rec.pid = e.pointerId; rec.lx = e.clientX; rec.ly = e.clientY;
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      b.classList.add('on');
      this.game.input?.setVirtual?.(def.action, true);
      if (navigator.vibrate && (def.id === 'attack' || def.id === 'enter')) { try { navigator.vibrate(8); } catch (err) { /* ignore */ } }
    });
    b.addEventListener('pointermove', (e) => {
      if (rec.pid !== e.pointerId || !def.look) return;
      const dx = e.clientX - rec.lx, dy = e.clientY - rec.ly;
      rec.lx = e.clientX; rec.ly = e.clientY;
      this.game.input?.addLook?.(dx * LOOK_GAIN, dy * LOOK_GAIN);
    });
    const up = (e) => {
      if (rec.pid !== e.pointerId) return;
      rec.pid = null;
      b.classList.remove('on');
      this.game.input?.setVirtual?.(def.action, false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }

  _bindLook(look) {
    look.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._look.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { look.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    look.addEventListener('pointermove', (e) => {
      const p = this._look.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      this.game.input?.addLook?.(dx * LOOK_GAIN, dy * LOOK_GAIN);
    });
    const end = (e) => { this._look.delete(e.pointerId); };
    look.addEventListener('pointerup', end);
    look.addEventListener('pointercancel', end);
  }

  _bindStick(zone) {
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this._stick) return;
      const W = window.innerWidth, H = window.innerHeight;
      const ox = Math.max(70, Math.min(W * 0.42 - 20, e.clientX));
      const oy = Math.max(H * 0.4, Math.min(H - this._hot - 50, e.clientY));
      this._stick = { id: e.pointerId, ox, oy };
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      this.stick.classList.add('active');
      this._moveStick(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (this._stick && this._stick.id === e.pointerId) this._moveStick(e.clientX, e.clientY);
    });
    const end = (e) => { if (this._stick && this._stick.id === e.pointerId) this._releaseStick(); };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
  }

  _moveStick(x, y) {
    const s = this._stick;
    let dx = x - s.ox, dy = y - s.oy;
    const d = Math.hypot(dx, dy);
    const R = STICK_R * (this.ts || 1);
    // drag the base along when pulled far past the edge (floating stick)
    if (d > R * 1.6) { const k = (d - R * 1.6) / d; s.ox += dx * k; s.oy += dy * k; dx = x - s.ox; dy = y - s.oy; }
    const m = Math.min(1, Math.hypot(dx, dy) / R);
    const ang = Math.atan2(dy, dx);
    const kx = Math.cos(ang) * m * R, ky = Math.sin(ang) * m * R;
    this._placeStick(s.ox, s.oy, kx, ky);
    let mag = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD);
    this._axis.x = Math.cos(ang) * mag;
    this._axis.y = -Math.sin(ang) * mag;
    const sprint = m > 0.94 && this._axis.y > 0.55;
    if (sprint !== this._sprint) {
      this._sprint = sprint;
      this.game.input?.setVirtual?.('sprint', sprint);
      this.stick.classList.toggle('sprint', sprint);
    }
  }

  _placeStick(cx, cy, kx, ky) {
    this.stick.style.left = cx + 'px';
    this.stick.style.top = cy + 'px';
    this.knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
  }

  _releaseStick() {
    this._stick = null;
    this._axis.x = 0; this._axis.y = 0;
    if (this._sprint) { this._sprint = false; this.game.input?.setVirtual?.('sprint', false); this.stick.classList.remove('sprint'); }
    this.stick.classList.remove('active');
    if (this._rest) this._placeStick(this._rest.x, this._rest.y, 0, 0);
    this.game.input?.setVirtualAxis?.(0, 0);
  }

  /** Release every held control (UI opened, pause...). */
  releaseAll() {
    if (!this.enabled) return;
    const input = this.game.input;
    for (const [, rec] of this.buttons) {
      if (rec.pid !== null) { rec.pid = null; rec.el.classList.remove('on'); input?.setVirtual?.(rec.def.action, false); }
    }
    this._look.clear();
    if (this._stick) this._releaseStick();
  }

  update() {
    if (!this.enabled || !this.root) return;
    const g = this.game;
    const p = g.player;
    const vis = g.state === 'playing' && !g.paused && !g.uiOpen;
    if (vis !== this._vis) {
      this._vis = vis;
      this.root.classList.toggle('off', !vis);
      if (!vis) this.releaseAll();
    }
    if (!vis) return;
    // context: on foot vs in a vehicle
    const ctx = p && p.inVehicle ? 'car' : 'foot';
    if (ctx !== this._ctx) {
      this._ctx = ctx;
      for (const [, rec] of this.buttons) {
        const show = rec.def.ctx === 'any' || rec.def.ctx === ctx;
        rec.el.classList.toggle('hide', !show);
        if (!show && rec.pid !== null) { rec.pid = null; rec.el.classList.remove('on'); g.input?.setVirtual?.(rec.def.action, false); }
        if (rec.def.carLabel && !rec.def.icon) rec.el.textContent = ctx === 'car' ? rec.def.carLabel : rec.def.label;
      }
    }
    // the joystick axis is re-applied every frame (input.clear() on UI changes resets it)
    if (this._stick) g.input?.setVirtualAxis?.(this._axis.x, this._axis.y);
  }
}
