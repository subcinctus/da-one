// The Game: owns renderer/scene/camera, the main loop, the system list, global state and the debug API.
// Every system receives `game` in its constructor and reaches other systems through it (game.world, game.player, ...).
import * as THREE from 'three';
import { EventBus } from './events.js';
import { Input } from './input.js';
import { EntityRegistry } from './entities.js';
import { loadSettings, saveSettings, DEFAULT_SEED } from './config.js';

export class Game {
  constructor(container) {
    this.container = container;
    this.settings = loadSettings();
    const params = new URLSearchParams(location.search);
    this.params = params;
    this.seed = parseInt(params.get('seed') || '', 10) || DEFAULT_SEED;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setClearColor(0x87b5e8);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !!this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.1, 1200);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera); // so camera-attached objects (first-person weapon) render

    this.events = new EventBus();
    this.input = new Input(this);
    this.entities = new EntityRegistry();

    /** 'loading' | 'title' | 'playing' */
    this.state = 'loading';
    /** true while the pause menu (or title) is up: simulation frozen */
    this.paused = true;
    /** Set of open UI panel ids (inventory, shop, map, pause...). While non-empty: input blocked + simulation paused. */
    this._ui = new Set();
    this.time = 0;          // simulated seconds (advances only while unpaused)
    this.realTime = 0;      // wall-clock seconds since start
    this.frame = 0;
    this.dt = 0;
    this.fps = 60;

    /** Ordered update list. Filled by main.js via addSystem(). */
    this.systems = [];
    /** Named system references, also set directly as game.<name>. */
    this.sys = {};

    this.debug = this._makeDebug();
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /**
   * Register a system. It becomes game[name]. Systems are updated in registration order.
   * sys may implement: init() (async ok), update(dt), lateUpdate(dt), getBlips(out), onResize(w,h).
   * sys.runWhenPaused = true  -> update() also runs while paused / UI open (HUD, menus, audio).
   */
  addSystem(name, sys) {
    this[name] = sys;
    this.sys[name] = sys;
    this.systems.push(sys);
    sys.__name = name;
    return sys;
  }

  get uiOpen() { return this._ui.size > 0; }

  /** Open a UI layer (pauses simulation, blocks gameplay input, releases pointer lock). */
  openUI(id) {
    this._ui.add(id);
    this.input.clear();
    this.input.exitLock();
    this.events.emit('uiChanged', { open: true, id, ids: [...this._ui] });
  }

  /** Close a UI layer. When the last one closes gameplay resumes (pointer lock re-requested; needs a user gesture). */
  closeUI(id) {
    if (!this._ui.delete(id)) return;
    this.input.clear();
    if (this._ui.size === 0 && this.state === 'playing') this.input.requestLock();
    this.events.emit('uiChanged', { open: false, id, ids: [...this._ui] });
  }

  isUIOpen(id) { return id ? this._ui.has(id) : this._ui.size > 0; }

  /** Simulation is running (not paused, no UI open). */
  get running() { return this.state === 'playing' && !this.paused && !this.uiOpen; }

  /** Called by the title screen "Play" button (a user gesture): unlock audio, grab pointer, start simulation. */
  startPlaying() {
    if (this.audio && this.audio.unlock) this.audio.unlock();
    this.state = 'playing';
    this.paused = false;
    this.input.requestLock();
    this.events.emit('gameStart', {});
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    this.input.clear();
    if (p) this.input.exitLock(); else this.input.requestLock();
    this.events.emit('pauseChanged', { paused: p });
  }

  saveSettings() {
    saveSettings(this.settings);
    this.renderer.shadowMap.enabled = !!this.settings.shadows;
    this.camera.fov = this.settings.fov;
    this.resize();
    this.events.emit('settingsChanged', this.settings);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 1.5) * (this.settings.pixelRatio || 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    for (const s of this.systems) if (s.onResize) s.onResize(w, h);
  }

  /** Gather minimap blips from every system implementing getBlips(out). */
  collectBlips(out = []) {
    out.length = 0;
    for (const s of this.systems) {
      if (s.getBlips) { try { s.getBlips(out); } catch (e) { console.error(`[${s.__name}] getBlips`, e); } }
    }
    return out;
  }

  start() {
    this._last = performance.now();
    requestAnimationFrame(this._loop);
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const rawDt = (now - this._last) / 1000;
    this._last = now;
    const dt = Math.min(0.05, Math.max(0, rawDt));
    this.dt = dt;
    this.realTime += dt;
    if (rawDt > 0) this.fps += (1 / Math.max(rawDt, 1e-3) - this.fps) * 0.05;
    this.frame++;
    const run = this.running;
    if (run) this.time += dt;

    for (const s of this.systems) {
      if (!s.update || (!run && !s.runWhenPaused)) continue;
      try { s.update(dt); } catch (e) { this._reportError(s, 'update', e); }
    }
    for (const s of this.systems) {
      if (!s.lateUpdate || (!run && !s.runWhenPaused)) continue;
      try { s.lateUpdate(dt); } catch (e) { this._reportError(s, 'lateUpdate', e); }
    }
    try { this.renderer.render(this.scene, this.camera); } catch (e) { this._reportError({ __name: 'renderer' }, 'render', e); }
    this.input.endFrame();
  }

  _reportError(sys, phase, e) {
    // Log each distinct error once per system/phase so a broken system cannot flood the console or kill the loop.
    this._errSeen = this._errSeen || new Set();
    const key = `${sys.__name}:${phase}:${e && e.message}`;
    if (this._errSeen.has(key)) return;
    this._errSeen.add(key);
    console.error(`[${sys.__name}] ${phase} error:`, e);
  }

  _makeDebug() {
    const game = this;
    return {
      /** Teleport player (y optional: placed on ground). */
      teleport(x, y, z) {
        const p = game.player;
        if (!p) return;
        if (z === undefined) { z = y; y = undefined; }
        if (y === undefined && game.world) y = game.world.findGround ? game.world.findGround(x, z) : 60;
        if (p.teleport) p.teleport(x, y, z); else p.position.set(x, y, z);
      },
      stats() {
        const info = game.renderer.info;
        return {
          fps: Math.round(game.fps),
          state: game.state,
          paused: game.paused,
          ui: [...game._ui],
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          entities: game.entities.list.length,
          entityKinds: game.entities.list.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {}),
          chunksLoaded: game.world && game.world.chunks ? game.world.chunks.size : null,
          player: game.player && game.player.position ? game.player.position.toArray().map((v) => +v.toFixed(2)) : null,
          inVehicle: !!(game.player && game.player.inVehicle),
          wanted: game.police ? game.police.wanted : null,
          money: game.player ? game.player.money : null,
          time: game.sky ? game.sky.time : null,
        };
      },
    };
  }
}
