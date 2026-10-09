// Shops (ARCHITECTURE.md §Shops): glowing markers in front of shop POIs. Walking (or, for the Pay'n'Spray, driving)
// into one opens a styled panel: gun shop, hardware store (+ Creative toggle), hospital, Pay'n'Spray, safehouse.
// Re-entering requires stepping out of the marker first. runWhenPaused: the panel's Esc handling and the marker
// animation keep running while the panel pauses the simulation.
import * as THREE from 'three';
import { MarkerManager } from './markers.js';
import { SHOP_TYPES, RESPRAY_COLORS, purchaseRounds } from './shop_defs.js';
import { buildGunShop, buildHardware, buildHospital, buildGarage, buildSafehouse, openFallbackModal, injectShopCss } from './shop_ui.js';
import { planOf, poisOfType, safe, notify, sound, fmtMoney, clamp01, h, uiLayer, injectCss, HAS_DOM } from './util.js';

const R_FOOT = 1.35;
const R_CAR = 3.4;
const REARM = 1.6;

const BUILDERS = {
  gunshop: { build: buildGunShop, width: 720, title: (s) => s.poi.name || 'Ammu-Blocks' },
  hardware: { build: buildHardware, width: 760, title: (s) => s.poi.name || 'Block Depot' },
  hospital: { build: buildHospital, width: 520, title: (s) => s.poi.name || 'Hospital' },
  garage: { build: buildGarage, width: 580, title: (s) => s.poi.name || 'Pay\'n\'Spray' },
  safehouse: { build: buildSafehouse, width: 640, title: () => 'Safehouse' },
};

const _v = new THREE.Vector3();

export class Shops {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** All shops: {id, type, poi, def, marker, x, y, z, armed}. */
    this.list = [];
    /** Open shop view: {shop, view, rec, fallback} | null. */
    this.view = null;
    /** Safehouse POI chosen as the respawn point (or null). */
    this.respawnPoi = null;
    this._hwTab = null;
    this._escCheck = 0;
    this._refreshQueued = false;
    this._promptCD = 0;
    this._fade = null;
  }

  init() {
    const g = this.game;
    this.markers = new MarkerManager(g);
    const plan = planOf(g);
    let id = 0;
    for (const type of Object.keys(SHOP_TYPES)) {
      for (const poi of poisOfType(plan, type)) {
        const def = SHOP_TYPES[type];
        const y = Number.isFinite(poi.y) ? poi.y : 28;
        const shop = { id: id++, type, poi, def, x: poi.x, y, z: poi.z, armed: true, inside: false, marker: null };
        shop.marker = this.markers.marker({
          x: poi.x, y, z: poi.z, color: def.color, icon: def.icon, label: def.name,
          radius: def.vehicle ? R_CAR * 0.95 : R_FOOT, height: def.vehicle ? 3.4 : 3.0, range: 150,
        });
        this.list.push(shop);
      }
    }
    const ev = g.events;
    const queue = () => { if (this.view) this._refreshQueued = true; };
    ev.on('moneyChanged', queue);
    ev.on('inventoryChanged', queue);
    ev.on('healthChanged', queue);
    ev.on('wantedChanged', queue);
    ev.on('playerRespawned', (e) => { this._onRespawn(e); this._disarmUnderPlayer(); });
    ev.on('gameStart', () => this._disarmUnderPlayer());
    // a busted / killed player inside a marker must step out before it re-opens
    ev.on('playerDied', () => { for (const s of this.list) s.armed = false; });
    if (HAS_DOM) injectShopCss();
    this._installDebug();
  }

  // ================================================================================================ frame

  update(dt) {
    const g = this.game;
    if (!this.markers) return; // runWhenPaused: the loop runs during loading, before init()
    this.markers.update(dt);
    if (this._fade) this._updateFade();

    // open panel: Esc / refresh handling (runs while the simulation is paused)
    if (this.view) {
      if (this._refreshQueued) { this._refreshQueued = false; safe(() => this.view.view.refresh()); }
      const input = g.input;
      if (this._escCheck > 0) {
        // Esc was pressed last frame: the HUD/menus normally closed the panel already; if not, close it now
        this._escCheck = 0;
        if (this.view) this.close();
      } else if (input && input.pressed('pause', true)) {
        this._escCheck = 1;
      }
      return;
    }
    this._escCheck = 0;
    if (!g.running) return;
    const p = g.player;
    if (!p || p.alive === false || !p.position) return;
    const veh = p.inVehicle || null;
    const pos = veh && veh.position ? veh.position : p.position;
    let prompt = null;
    for (const s of this.list) {
      const d = Math.hypot(pos.x - s.x, pos.z - s.z);
      const dy = Math.abs(pos.y - s.y);
      const r = s.def.vehicle ? R_CAR : R_FOOT;
      const inside = d < r && dy < 3;
      s.marker.active = d < r + 0.5 && dy < 3;
      if (!inside) {
        if (d > r + REARM || dy > 4) s.armed = true;
        continue;
      }
      if (s.def.vehicle && !veh) { prompt = 'Drive a vehicle in here for a respray (' + fmtMoney(250) + ').'; continue; }
      if (!s.def.vehicle && veh) { prompt = 'Get out of the vehicle to enter the ' + (s.poi.name || s.def.name) + '.'; continue; }
      if (!s.armed || p.frozen || g.uiOpen) continue;
      if (s.type === 'garage' && veh && (veh.destroyed || veh.isHeli)) { prompt = veh.isHeli ? 'Helicopters do not fit in the spray booth.' : 'This wreck is beyond saving.'; continue; }
      s.armed = false;
      this.open(s);
      break;
    }
    if (prompt) safe(() => g.hud && g.hud.prompt && g.hud.prompt(prompt));
  }

  /** Markers the player is standing in right now must be stepped out of before they open (spawn, respawn, load). */
  _disarmUnderPlayer() {
    const p = this.game.player;
    if (!p || !p.position) return;
    for (const s of this.list) {
      const r = s.def.vehicle ? R_CAR : R_FOOT;
      if (Math.hypot(p.position.x - s.x, p.position.z - s.z) < r + REARM && Math.abs(p.position.y - s.y) < 4) s.armed = false;
    }
  }

  // ================================================================================================ open / close

  /** Open a shop panel (shop record or type string). */
  open(shop) {
    const g = this.game;
    if (typeof shop === 'string') shop = this.list.find((s) => s.type === shop) || null;
    if (!shop || this.view) return false;
    const b = BUILDERS[shop.type];
    if (!b || !HAS_DOM) return false;
    let view;
    try { view = b.build({ game: g, shops: this, poi: shop.poi, shop }); } catch (e) { console.error('[shops] build panel', e); return false; }
    // park the car so it does not roll out of the booth
    const veh = g.player && g.player.inVehicle;
    if (veh && veh.velocity) { veh.velocity.set(0, 0, 0); veh.speed = 0; }
    g.openUI('shop');
    const title = b.title(shop);
    const onClose = () => this._onClosed();
    let rec = null, fallback = false;
    if (g.hud && typeof g.hud.openPanel === 'function') {
      try { rec = g.hud.openPanel(title, view.el, { onClose, width: b.width, uiId: 'shop' }); } catch (e) { rec = null; }
    }
    if (!rec) { rec = openFallbackModal(title, view.el, { onClose, width: b.width }); fallback = true; sound(g, 'ui_open'); }
    this.view = { shop, view, rec, fallback };
    g.events.emit('shopOpened', { shop: shop.type, poi: shop.poi });
    return true;
  }

  /** Close the open shop panel. */
  close() {
    const v = this.view;
    if (!v) return;
    if (v.rec && typeof v.rec.close === 'function') v.rec.close();
    else this._onClosed();
  }

  get isOpen() { return !!this.view; }

  _onClosed() {
    const g = this.game;
    const v = this.view;
    if (!v) return;
    this.view = null;
    g.closeUI('shop');
    g.events.emit('shopClosed', { shop: v.shop.type, poi: v.shop.poi });
  }

  // ================================================================================================ transactions

  /** Rounds that come with a newly bought weapon. */
  purchaseRounds(id) { return purchaseRounds(id); }

  /**
   * Charge `price` for `desc` if apply() succeeds. apply() returns true, false, a refusal message (string), or a
   * fraction 0..1 (partial delivery -> partial charge). btn/card get shake / pop feedback.
   */
  purchase(price, desc, apply, btn = null, card = null, opts = {}) {
    const g = this.game;
    const p = g.player;
    if (!p) return false;
    price = Math.max(0, Math.round(Number(price) || 0));
    if (price > 0 && (p.money || 0) < price) {
      sound(g, 'error');
      notify(g, 'You can\'t afford that: ' + desc + ' costs ' + fmtMoney(price) + '.', { duration: 2.6, color: '#e5484d' });
      shake(btn);
      return false;
    }
    let r;
    try { r = apply(); } catch (e) { console.error('[shops] purchase', e); r = false; }
    if (r === false || r === null || r === undefined || typeof r === 'string') {
      sound(g, 'error');
      if (typeof r === 'string') notify(g, r, { duration: 2.4, color: '#e5484d' });
      shake(btn);
      this._refreshQueued = true;
      return false;
    }
    const frac = typeof r === 'number' ? clamp01(r) : 1;
    const cost = Math.round(price * frac);
    if (cost > 0 && typeof p.addMoney === 'function') p.addMoney(-cost, 'purchase');
    sound(g, 'purchase');
    notify(g, 'Purchased *' + desc + '*' + (cost > 0 ? ' for ' + fmtMoney(cost) : '') + (frac < 1 ? ' (inventory full)' : '') + '.', { duration: 2.2, color: '#46c46f' });
    pop(card);
    this._refreshQueued = true;
    if (opts.closeAfter) setTimeout(() => this.close(), 350);
    return true;
  }

  /** Pay'n'Spray: repair + repaint + lose the cops. */
  respray(v, color) {
    const g = this.game;
    if (!v) return false;
    if (typeof v.repair === 'function') v.repair();
    else { v.health = v.maxHealth || v.health; v.onFire = false; }
    let c = Number.isFinite(color) ? color >>> 0 : null;
    if (c === null) {
      const opts = RESPRAY_COLORS.filter((x) => x.hex !== (Number(v.color) >>> 0));
      c = opts[Math.floor(Math.random() * opts.length)].hex;
    }
    if (typeof v.setColor === 'function') v.setColor(c); else v.color = c;
    const police = g.police;
    const wanted = police ? police.wanted | 0 : 0;
    if (wanted > 0 && police) {
      if (typeof police.clearWanted === 'function') police.clearWanted(); else if (typeof police.setWanted === 'function') police.setWanted(0);
      notify(g, 'New paint, new plates. *The cops lost your trail.*', { duration: 3.5, color: '#46c46f' });
    } else {
      notify(g, 'Respray complete. Looking sharp!', { duration: 2.6, color: '#46c46f' });
    }
    if (v.position) {
      _v.copy(v.position); _v.y += 1;
      safe(() => g.fx && g.fx.smoke && g.fx.smoke(_v.clone(), { amount: 18, color: c }));
      safe(() => g.fx && g.fx.burst && g.fx.burst(_v.clone(), { color: c, count: 40, speed: 4, size: 0.12, life: 1.1, gravity: 2 }));
    }
    g.events.emit('vehicleResprayed', { vehicle: v, color: c });
    return true;
  }

  /** Safehouse: save the game. Returns true on success. */
  saveGame() {
    const g = this.game;
    const w = g.police ? g.police.wanted | 0 : 0;
    if (w > 0) { sound(g, 'error'); notify(g, 'You can\'t save with the cops on your tail.', { duration: 2.6, color: '#e5484d' }); return false; }
    let ok = false;
    try { ok = !!(g.save && typeof g.save.save === 'function' && g.save.save({ reason: 'safehouse' }) !== false); } catch (e) { ok = false; }
    sound(g, ok ? 'checkpoint' : 'error');
    notify(g, ok ? 'Game saved.' : 'Saving is unavailable here.', { duration: 2.4, color: ok ? '#46c46f' : '#e5484d' });
    return ok;
  }

  /** Safehouse: sleep until 08:00 (fade out / in), heal and save. */
  sleep() {
    const g = this.game;
    const w = g.police ? g.police.wanted | 0 : 0;
    if (w > 0) { sound(g, 'error'); notify(g, 'You can\'t sleep with the cops on your tail.', { duration: 2.6, color: '#e5484d' }); return false; }
    this.close();
    this._startFade(() => {
      safe(() => g.sky && g.sky.setTime && g.sky.setTime(8));
      const p = g.player;
      if (p && typeof p.heal === 'function') p.heal(p.maxHealth || 100);
      safe(() => g.save && g.save.save && g.save.save({ reason: 'sleep' }));
    }, () => {
      notify(g, 'You slept until *08:00*. Health restored, game saved.', { duration: 3.2, color: '#3fa9ff' });
    });
    return true;
  }

  /** Safehouse: wake up here after WASTED (instead of the hospital). Toggling the same POI clears it. */
  setRespawn(poi) {
    const g = this.game;
    this.respawnPoi = poi || null;
    const p = g.player;
    if (p && typeof p.setRespawnPoint === 'function') safe(() => p.setRespawnPoint(poi ? { x: poi.x, y: poi.y, z: poi.z, yaw: (poi.yaw || 0) + Math.PI } : null));
    sound(g, 'checkpoint');
    notify(g, poi ? 'Respawn point set: you will wake up at the *safehouse*.' : 'Respawn point cleared.', { duration: 2.6, color: '#3fa9ff' });
  }

  _onRespawn(e) {
    const g = this.game;
    if (!e || e.reason !== 'death' || !this.respawnPoi) return;
    const poi = this.respawnPoi;
    const p = g.player;
    if (!p || typeof p.teleport !== 'function') return;
    // Player respawns at the nearest hospital; move to the chosen safehouse door (facing the street).
    const yaw = (poi.yaw || 0) + Math.PI;
    p.teleport(poi.x + Math.sin(yaw) * 1.5, poi.y, poi.z + Math.cos(yaw) * 1.5);
    p.yaw = yaw;
    if (g.cameraRig) { g.cameraRig.yaw = yaw; safe(() => g.cameraRig.snap && g.cameraRig.snap()); }
  }

  // ================================================================================================ sleep fade

  _startFade(mid, end) {
    if (!HAS_DOM) { mid(); end(); return; }
    injectCss('fade', '.bcm-fade{position:absolute;inset:0;z-index:70;background:#000;opacity:0;pointer-events:none;display:flex;align-items:center;justify-content:center;font:800 30px/1 var(--font-display);letter-spacing:.2em;color:#cfd8e3;text-transform:uppercase}');
    const el = h('div', 'bcm-fade', uiLayer());
    el.textContent = 'Zzz...';
    this._fade = { el, t: 0, mid, end, didMid: false };
    this.game.openUI('sleep');
  }

  _updateFade() {
    const f = this._fade;
    // real time (not the clamped frame dt): the fade must take the same wall-clock time at any frame rate
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    f.t += Math.min(0.25, Math.max(0, (now - (f.last || now)) / 1000));
    f.last = now;
    const T_IN = 0.9, HOLD = 1.1, T_OUT = 0.9;
    let o;
    if (f.t < T_IN) o = f.t / T_IN;
    else if (f.t < T_IN + HOLD) {
      o = 1;
      if (!f.didMid) { f.didMid = true; try { f.mid(); } catch (e) { console.error('[shops] sleep', e); } }
    } else o = 1 - (f.t - T_IN - HOLD) / T_OUT;
    f.el.style.opacity = String(Math.max(0, Math.min(1, o)));
    if (f.t >= T_IN + HOLD + T_OUT) {
      if (!f.didMid) { try { f.mid(); } catch (e) { /* ignore */ } }
      f.el.remove();
      this._fade = null;
      this.game.closeUI('sleep');
      try { f.end(); } catch (e) { /* ignore */ }
    }
  }

  // ================================================================================================ blips

  getBlips(out) {
    for (const s of this.list) {
      out.push({ x: s.x, z: s.z, color: s.def.blip, icon: s.def.blipIcon, size: 5, label: s.poi.name || s.def.name, edge: false });
    }
  }

  // ================================================================================================ debug

  _installDebug() {
    const g = this.game;
    const d = g.debug;
    if (!d) return;
    const self = this;
    d.shops = () => self.list.map((s) => ({ id: s.id, type: s.type, name: s.poi.name, x: +s.x.toFixed(1), y: s.y, z: +s.z.toFixed(1) }));
    /** Teleport onto a shop marker (type or id). The panel opens on the next frames like a real walk-in. */
    d.gotoShop = (typeOrId = 'gunshop') => {
      const s = typeof typeOrId === 'number' ? self.list[typeOrId] : self.list.find((x) => x.type === typeOrId);
      if (!s) return null;
      s.armed = true;
      d.teleport?.(s.x, s.y, s.z);
      return { type: s.type, name: s.poi.name };
    };
    /** Open a shop panel directly. */
    d.openShop = (type = 'gunshop') => self.open(type);
    d.closeShop = () => { self.close(); return !self.view; };
    d.shopState = () => ({ open: self.view ? self.view.shop.type : null, fallback: !!(self.view && self.view.fallback), respawn: self.respawnPoi ? self.respawnPoi.name : null });
  }
}

function shake(btn) {
  if (!btn || !btn.classList) return;
  btn.classList.remove('shake');
  void btn.offsetWidth;
  btn.classList.add('shake');
}

function pop(el) {
  if (!el || !el.classList) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}
