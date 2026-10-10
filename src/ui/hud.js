// HUD (see ARCHITECTURE.md §HUD): GTA V conventions blended with a Minecraft hotbar.
//   bottom-left  radar (minimap.js) + health / armor bars          top-right  clock, weapon + ammo, wanted stars, money
//   top-left     help-text notifications (queued, max 3) + FPS     top-centre mission timer
//   bottom-ctr   prompt, objective subtitle, item name, hotbar     bottom-right vehicle / area names, speedometer
//   centre       crosshair, hit marker, mining ring, damage arcs   overlays  WASTED / BUSTED / MISSION PASSED, vignette, scope
// Also owns the loading screen, the full-screen map (M), the inventory screen (E) and generic panels (openPanel).
// runWhenPaused: update() runs every frame; it touches the DOM only when a displayed value changes.
import * as THREE from 'three';
import { injectStyles, uiRoot, el } from './styles.js';
import { LoadingScreen } from './loading.js';
import { TopRight, Vitals, Speedo } from './hud_status.js';
import { Notifier, BigMessage, Subtitles, MissionTimer, Names } from './hud_text.js';
import { Crosshair, ScreenFX } from './hud_center.js';
import { Hotbar } from './hotbar.js';
import { Minimap, MapData, cameraYaw } from './minimap.js';
import { FullMap } from './map.js';
import { InventoryScreen } from './inventory_ui.js';
import { PanelStack } from './panels.js';

const _v = new THREE.Vector3();

export class HUD {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** GPS waypoint {x, z} | null (set by the map, missions...). */
    this.waypoint = null;
    /** Mining progress 0..1 | null (set by Player each frame while mining). */
    this.miningProgress = null;
    /** UI scale of the HUD clusters (1 at 1280x720). */
    this.scale = 1;
    this.touchMode = false;
    this._loading = new LoadingScreen();
    this._inited = false;
    this._off = null;
    this._cine = null;
    this._speed = null;
    this._speedT = -1;
    this._userWp = null;
    this._areaT = 0;
    this._areaName = null;
    this._areaDelay = 0;
    this._later = [];
    this._fpsOn = null;
    this._fpsT = 0;
    this._fpsTxt = '';
    this._lastLock = null;
    /** UI layer ids that Esc / closeTop() never closes (their owner closes them: pause menu, sleep fade...). */
    this.nonDismissable = new Set(['pause', 'sleep']);
  }

  // ================================================================== loading screen

  /** Loading bar (0..1) + status text. Works before init(). */
  setLoading(p, text) { try { this._loading.set(p, text); } catch (e) { /* DOM unavailable */ } }

  hideLoading() { try { this._loading.hide(); } catch (e) { /* ignore */ } }

  // ================================================================== lifecycle

  init() {
    injectStyles();
    const g = this.game;
    const ui = uiRoot();
    this.layerRoot = ui;
    this.mapData = new MapData(g);

    // main HUD root
    const root = el('div', 'bc-hud off', ui);
    this.root = root;
    this.fx = new ScreenFX(this);
    const fxl = el('div', 'bc-fxl', root);
    fxl.style.cssText = 'position:absolute;inset:0';
    this.fx.mount(fxl);

    this.crosshair = new Crosshair(this);
    this.crosshair.mount(root);

    const tc = el('div', 'cl bc-tc', root);
    this.timer = new MissionTimer(this);
    this.timer.mount(tc);

    const tr = el('div', 'cl bc-tr', root);
    this.topRight = new TopRight(this);
    this.topRight.mount(tr);

    const bl = el('div', 'cl bc-bl', root);
    this.minimap = new Minimap(this);
    this.minimap.mount(bl);
    this.vitals = new Vitals(this);
    this.vitals.mount(bl);

    const br = el('div', 'cl bc-br', root);
    this.names = new Names(this);
    this.names.mount(br);
    this.speedo = new Speedo(this);
    this.speedo.mount(br);

    const bc = el('div', 'cl bc-bc', root);
    this.subs = new Subtitles(this);
    this.subs.mount(bc);
    this.hotbar = new Hotbar(this);
    this.hotbar.mount(bc);

    this.big = new BigMessage(this);
    this.big.mount(root);

    // notifications + FPS live above panels (shops notify while their panel is open)
    const top = el('div', 'bc-hud bc-hud-top off', ui);
    this.topRoot = top;
    const tl = el('div', 'cl bc-tl', top);
    this.fpsEl = el('div', 'bc-fps hide', tl, 'FPS');
    this.notifier = new Notifier(this);
    this.notifier.mount(tl);

    this.panels = new PanelStack(this);
    this.fullMap = new FullMap(this);
    this.inventoryUI = new InventoryScreen(this);

    this._wire();
    this._installDebug();
    this._inited = true;
    this.onResize(window.innerWidth, window.innerHeight);
  }

  _wire() {
    const g = this.game;
    const ev = g.events;
    const isPlayer = (e) => !!e && e === g.player;
    ev.on('gameStart', () => { this._areaName = null; this._areaDelay = 1.2; });
    // pre-render the map image while the title screen is up (avoids a hitch on the first radar frame)
    ev.on('ready', () => { try { this.mapData.ensure(); } catch (e) { /* plan unavailable */ } });
    ev.on('uiChanged', (e) => this.panels.onUiChanged(e));
    ev.on('moneyChanged', (e) => this.topRight.onMoney(e));
    ev.on('inventoryChanged', () => this.hotbar.invalidate());
    ev.on('weaponChanged', () => this.hotbar.invalidate());
    ev.on('weaponFired', (e) => { if (e && e.byPlayer) this.crosshair.kick(e.weapon && e.weapon.id ? e.weapon.id : e.weapon); });
    ev.on('entityDamaged', (e) => {
      if (!e) return;
      const info = e.info || {};
      const ent = e.entity;
      if (isPlayer(info.source) && ent && !isPlayer(ent) && ent.kind !== 'vehicle' && ent.kind !== 'heli') {
        if (ent.alive !== false) this.hitMarker(false);
      }
      if (isPlayer(e.entity)) this._damageDirection(info, e.amount);
    });
    ev.on('entityKilled', (e) => {
      const ent = e && e.entity;
      if (ent && e.info && isPlayer(e.info.source) && !isPlayer(ent) && ent.kind !== 'vehicle' && ent.kind !== 'heli') this.hitMarker(true);
    });
    ev.on('playerDied', () => {
      this.fx.setFilter('grayscale(1) contrast(1.12) brightness(.78)', 4.6);
      this.miningProgress = null;
      // priority: pre-empts a queued / showing mission intro or MISSION PASSED (shown before the respawn)
      this._delay(0.55, () => this.bigMessage('WASTED', '', { color: 'var(--wasted)', duration: 3.3, priority: true }));
    });
    ev.on('playerRespawned', () => { this.fx.clearFilter(); });
    ev.on('busted', () => {
      this.fx.setFilter('grayscale(.85) brightness(.82) contrast(1.08)', 3.8);
      this.bigMessage('BUSTED', '', { color: 'var(--busted)', duration: 3, priority: true });
    });
    ev.on('vehicleEnter', (e) => {
      if (!e || !e.vehicle) return;
      if (e.character && !isPlayer(e.character)) return;
      const v = e.vehicle;
      this.showVehicleName((v.def && v.def.name) || v.name || v.type);
    });
    ev.on('settingsChanged', () => { this._fpsOn = null; });
  }

  _delay(sec, fn) { this._later.push({ t: sec, fn }); }

  _damageDirection(info, amount) {
    const g = this.game;
    const p = g.player;
    if (!p || !p.position) return;
    let sx = null, sz = null;
    const src = info.source;
    if (src && src !== p && src.position) { sx = src.position.x; sz = src.position.z; }
    else if (info.point && Number.isFinite(info.point.x) && (info.type === 'bullet' || info.type === 'explosion' || info.type === 'melee' || info.type === 'vehicle')) {
      sx = info.point.x; sz = info.point.z;
    } else if (info.dir && Number.isFinite(info.dir.x)) { sx = p.position.x - info.dir.x * 5; sz = p.position.z - info.dir.z * 5; }
    if (sx === null) return;
    const dx = sx - p.position.x, dz = sz - p.position.z;
    if (Math.hypot(dx, dz) < 0.4) return;
    const yaw = cameraYaw(g, _v);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const fwd = dx * fx + dz * fz;
    const right = dx * -fz + dz * fx;     // right = (-cos yaw, sin yaw)
    this.crosshair.damageFrom(Math.atan2(right, fwd), Math.min(1, (Number(amount) || 10) / 30));
  }

  // ================================================================== public API (contract)

  /** Help-text box (top-left, queued, max 3 visible). opts: {duration = 4, color}. Supports [Key] caps and *highlight*. */
  notify(text, opts = {}) { if (this.notifier) this.notifier.push(text, opts || {}); else this._pendingNotes = (this._pendingNotes || []).concat([[text, opts]]); }

  /**
   * Big centred message with letterbox bars (WASTED / BUSTED / MISSION PASSED...). opts: {color, duration = 3,
   * priority}: a priority message drops the queue and cuts the current one off (later messages queue behind it).
   */
  bigMessage(title, subtitle = '', opts = {}) { this.big?.push(title, subtitle, opts || {}); }

  /** Contextual prompt (per-frame: call it every frame while it applies; it clears itself). */
  prompt(text) { this.subs?.request(text, this.game.realTime || 0); }

  /** Mission objective subtitle (bottom-centre). null clears. */
  setObjective(text) { this.subs?.setObjective(text); }

  /** Mission countdown (seconds) or null. Counts down on its own between calls. */
  setTimer(seconds) { this.timer?.set(seconds, this.game.time || 0); }

  /** Remaining mission-timer seconds (null when off). */
  timerRemaining() { return this.timer ? this.timer.remaining(this.game.time || 0) : null; }

  /** Vehicle name fade-in (bottom-right). */
  showVehicleName(name) { this.names?.showVehicle(name); }

  /** District / area name fade-in (bottom-right). */
  showArea(name) { this.names?.showArea(name); }

  /** Red damage vignette (0..1). */
  flashDamage(intensity = 0.5) { this.fx?.damage(intensity); }

  /** Hit marker on the crosshair (red when the target died). */
  hitMarker(killed = false) { this.crosshair?.hitMarker(killed); }

  /** Speedometer override in km/h (null = read vehicles.playerVehicle.speed). */
  setSpeed(kmh) {
    if (kmh === null || kmh === undefined) { this._speed = null; return; }
    this._speed = Number(kmh);
    this._speedT = this.game.realTime || 0;
  }

  /** Modal panel (shops, mission log...). opts: {onClose, width}. Returns the panel record ({root, body, close()}). */
  openPanel(title, element, opts = {}) { return this.panels.openPanel(title, element, opts || {}); }

  /** Close the top-most panel. */
  closePanel() { return this.panels ? this.panels.closeTop() : false; }

  // ================================================================== extra API

  /** Set / clear the GPS waypoint. `user` = set from the map (auto-clears on arrival). */
  setWaypoint(wp, user = false) {
    this.waypoint = wp && Number.isFinite(wp.x) && Number.isFinite(wp.z) ? { x: wp.x, z: wp.z } : null;
    this._userWp = user ? this.waypoint : null;
  }

  openMap() { if (!this.fullMap.isOpen && !this.game.uiOpen) this.fullMap.open(); }
  closeMap() { this.fullMap.close(); }
  toggleMap() { if (this.fullMap.isOpen) this.fullMap.close(); else this.openMap(); }
  openInventory() { if (!this.inventoryUI.isOpen && !this.game.uiOpen) this.inventoryUI.open(); }
  closeInventory() { this.inventoryUI.close(); }
  toggleInventory() { if (this.inventoryUI.isOpen) this.inventoryUI.close(); else this.openInventory(); }

  /** Promise<boolean> confirm dialog. */
  confirm(title, text, opts) { return this.panels.confirm(title, text, opts); }

  /** True while one of the HUD's layers (inventory, map, panels, confirm) is open. */
  get layerOpen() { return !!(this.panels?.open || this.panels?.confirmOpen || this.inventoryUI?.isOpen || this.fullMap?.isOpen); }

  /**
   * Close the top-most closable layer (Esc): confirm > panels > inventory > map > any other open UI id except the
   * non-dismissable ones (pause menu, sleep fade). Returns true if something was closed.
   */
  closeTop() {
    if (!this._inited) return false;
    if (this.panels.closeConfirm()) return true;
    if (this.panels.closeTop()) { this.game.audio?.play?.('ui_click'); return true; }
    if (this.inventoryUI.isOpen) { this.inventoryUI.close(); return true; }
    if (this.fullMap.isOpen) { this.fullMap.close(); return true; }
    const ids = this.game._ui ? [...this.game._ui] : [];
    for (let i = ids.length - 1; i >= 0; i--) {
      if (this.nonDismissable.has(ids[i])) continue;
      this.game.closeUI(ids[i]);
      return true;
    }
    return false;
  }

  /** Switch the layout for touch controls (radar top-left, tappable hotbar). Called by TouchControls. */
  setTouchMode(on) {
    this.touchMode = !!on;
    if (this.root) {
      this.root.classList.toggle('touch', this.touchMode);
      this.topRoot.classList.toggle('touch', this.touchMode);
      this.onResize(window.innerWidth, window.innerHeight);
    }
  }

  onResize(w, h) {
    if (!this._inited) return;
    w = w || window.innerWidth; h = h || window.innerHeight;
    let s = Math.min(w / 1280, h / 720);
    if (w < 760 || h < 480) s = Math.min(w / 560, h / 560);
    s = Math.max(0.6, Math.min(1.8, s));
    this.scale = s;
    const ui = this.layerRoot;
    ui.style.setProperty('--s', s.toFixed(3));
    const portrait = h > w;
    this.root.classList.toggle('portrait', portrait);
    this.topRoot.classList.toggle('portrait', portrait);
    this.minimap.resize(s);
    this.fullMap.onResize();
  }

  // ================================================================== per frame

  update(dt) {
    if (!this._inited) { this._loading.update(dt); return; }
    const g = this.game;
    const p = g.player;
    const playing = g.state === 'playing';
    const visible = playing && !g.paused;
    const free = visible && !g.uiOpen;
    const alive = !p || p.alive !== false;

    if (this._pendingNotes) { for (const [t, o] of this._pendingNotes) this.notifier.push(t, o || {}); this._pendingNotes = null; }

    const off = !visible;
    if (off !== this._off) {
      this._off = off;
      this.root.classList.toggle('off', off);
      this.topRoot.classList.toggle('off', off);
    }
    const below = this.fullMap.isOpen;
    if (below !== this._below) { this._below = below; this.topRoot.classList.toggle('below-header', below); }
    const cine = this.big.active && /^(wasted|busted)$/i.test(this.big.title || '');
    if (cine !== this._cine) { this._cine = cine; this.root.classList.toggle('cine', cine); this.topRoot.classList.toggle('cine', cine); }

    if (playing && (!g.paused || this.layerOpen)) this._handleKeys(g.paused);

    // delayed actions (simulated-time independent)
    for (let i = this._later.length - 1; i >= 0; i--) {
      const it = this._later[i];
      it.t -= dt;
      if (it.t <= 0) { this._later.splice(i, 1); try { it.fn(); } catch (e) { console.error('[hud] delayed', e); } }
    }

    this.notifier.update(dt, visible);
    this.big.update(dt, visible);
    this.fx.update(dt, visible);
    this.fullMap.update(dt, _v);
    this.inventoryUI.update(dt);
    if (!playing) return;

    this.topRight.update(dt);
    this.vitals.update();
    if (visible) this.minimap.update(dt, _v);
    this.hotbar.update(dt);
    const now = g.realTime || 0;
    const spd = this._speed !== null && now - this._speedT < 0.3 ? this._speed : null;
    this.speedo.update(dt, spd);
    this.names.update(dt);
    this.timer.update(g.time || 0);
    this.subs.update(now, free && alive && !this.big.active);
    this.crosshair.update(dt, free && alive && !cine);

    // FPS counter
    const fpsOn = !!(g.settings && g.settings.showFPS);
    if (fpsOn !== this._fpsOn) { this._fpsOn = fpsOn; this.fpsEl.classList.toggle('hide', !fpsOn); }
    if (fpsOn) {
      this._fpsT -= dt;
      if (this._fpsT <= 0) {
        this._fpsT = 0.25;
        const info = g.renderer && g.renderer.info;
        const txt = Math.round(g.fps || 0) + ' FPS' + (info ? '  ·  ' + info.render.calls + ' draws' : '');
        if (txt !== this._fpsTxt) { this._fpsTxt = txt; this.fpsEl.textContent = txt; }
      }
    }

    if (visible && p && p.position) {
      this._pollArea(dt, p);
      this._checkArrival(p);
    }
  }

  /** M / E toggles. While paused (a layer opened from the pause menu) keys can only close. */
  _handleKeys(paused) {
    const g = this.game;
    const input = g.input;
    if (!input) return;
    const p = g.player;
    const alive = !p || p.alive !== false;
    if (input.pressed('map', true)) {
      if (this.fullMap.isOpen) this.fullMap.close();
      else if (paused) { /* nothing */ } else if (!g.uiOpen) this.fullMap.open();
      else if (this.inventoryUI.isOpen) { this.inventoryUI.close(); this.fullMap.open(); }
    }
    if (input.pressed('inventory', true)) {
      if (this.inventoryUI.isOpen) this.inventoryUI.close();
      else if (paused || !alive) { /* nothing */ } else if (!g.uiOpen) this.inventoryUI.open();
      else if (this.fullMap.isOpen) { this.fullMap.close(); this.inventoryUI.open(); }
    }
  }

  _pollArea(dt, p) {
    if (this._areaDelay > 0) { this._areaDelay -= dt; return; }
    this._areaT -= dt;
    if (this._areaT > 0) return;
    this._areaT = 0.5;
    const plan = this.game.generator && this.game.generator.plan;
    if (!plan || typeof plan.districtAt !== 'function') return;
    let d = null;
    try { d = plan.districtAt(p.position.x, p.position.z); } catch (e) { d = null; }
    const name = d && (d.name || d.id) ? String(d.name || d.id) : null;
    if (name && name !== this._areaName) {
      this._areaName = name;
      this.showArea(name);
    }
  }

  _checkArrival(p) {
    const wp = this.waypoint;
    if (!wp || wp !== this._userWp) return;
    const pos = p.inVehicle && p.inVehicle.position ? p.inVehicle.position : p.position;
    if (Math.hypot(wp.x - pos.x, wp.z - pos.z) < (p.inVehicle ? 14 : 8)) {
      this.setWaypoint(null);
      this.notify('You have reached your waypoint.', { duration: 2.5, color: '#e040fb' });
      this.game.audio?.play?.('checkpoint', { volume: 0.6 });
    }
  }

  // ================================================================== debug

  _installDebug() {
    const g = this.game;
    if (!g.debug) return;
    const hud = this;
    g.debug.hud = hud;
    g.debug.openMap = () => { hud.openMap(); return hud.fullMap.isOpen; };
    g.debug.openInventory = () => { hud.openInventory(); return hud.inventoryUI.isOpen; };
    g.debug.closeTop = () => hud.closeTop();
    g.debug.hudState = () => ({
      scale: +hud.scale.toFixed(3),
      touch: hud.touchMode,
      off: hud._off,
      notes: hud.notifier.live.map((n) => n.text),
      queued: hud.notifier.queue.length,
      big: hud.big.title,
      prompt: hud.subs._shown,
      objective: hud.subs._obj,
      timer: hud.timerRemaining(),
      money: hud.topRight._moneyTxt,
      wanted: hud.topRight._wanted,
      speedo: hud.speedo._on ? hud.speedo._kmh : null,
      waypoint: hud.waypoint,
      route: hud.minimap.route ? hud.minimap.route.length / 2 : 0,
      crosshair: hud.crosshair._vis,
      map: hud.fullMap.isOpen,
      inventory: hud.inventoryUI.isOpen,
      panels: hud.panels.stack.length,
      ui: g._ui ? [...g._ui] : [],
      area: hud._areaName,
    });
  }
}
