// The Game: renderer, scene, camera, the fixed-step loop and the system registry.
//
// LOOP: the simulation runs at a FIXED 120 Hz (SIM_HZ) regardless of display rate; rendering runs every
// requestAnimationFrame (60/120/144 Hz...). Systems implement:
//   fixedUpdate(dt)        simulation step, dt = 1/120 (combat, AI, physics, animation time). Skipped while paused,
//                          while a UI layer is open, and during hitstop.
//   update(dt, alpha)      once per rendered frame (visual smoothing, camera, FX, HUD). alpha = interpolation factor
//                          between the last two sim states (0..1). Runs while paused only if runWhenPaused.
//   init(onProgress), getBlips?, onResize(w, h)
// HIT FEEL helpers: game.hitstop(seconds) freezes simulation for a few frames (real time);
// game.slowmo(scale, seconds) scales simulation speed (focus attacks, last-enemy kill).
import * as THREE from 'three';
import { EventBus } from './events.js';
import { Input } from './input.js';

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

const SETTINGS_KEY = 'laststance.settings.v1';
export const DEFAULT_SETTINGS = {
  volume: 0.8, music: 0.5, rumble: true, cameraSensitivity: 1, invertY: false,
  shadows: true, pixelRatio: 1, showFPS: false, hitPause: true, screenShake: true,
};

export class Game {
  constructor(container) {
    this.container = container;
    this.params = new URLSearchParams(location.search);
    this.settings = { ...DEFAULT_SETTINGS };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* ignore */ }

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = !!this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 400);
    this.scene.add(this.camera);

    this.events = new EventBus();
    this.input = new Input(this);

    /** 'loading' | 'title' | 'playing' */
    this.state = 'loading';
    this.paused = false;
    this._ui = new Set();
    this.time = 0;        // simulation seconds
    this.realTime = 0;
    this.frame = 0;
    this.simSteps = 0;
    this.fps = 120;
    this.alpha = 0;
    this.timeScale = 1;   // slowmo
    this._slowT = 0;
    this._hitstopT = 0;   // remaining real seconds of frozen simulation
    this._acc = 0;
    this.systems = [];
    this.sys = {};
    this.debug = this._makeDebug();
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  addSystem(name, sys) {
    this[name] = sys; this.sys[name] = sys; this.systems.push(sys); sys.__name = name;
    return sys;
  }

  get uiOpen() { return this._ui.size > 0; }
  openUI(id) { this._ui.add(id); this.input.exitLock(); this.input.clearBuffer(); this.events.emit('uiChanged', { open: true, id, ids: [...this._ui] }); }
  closeUI(id) { if (this._ui.delete(id)) { this.input.clearBuffer(); this.events.emit('uiChanged', { open: false, id, ids: [...this._ui] }); } }
  isUIOpen(id) { return id ? this._ui.has(id) : this._ui.size > 0; }
  /** Simulation advances only while this is true. */
  get running() { return this.state === 'playing' && !this.paused && !this.uiOpen; }

  setPaused(p) { if (this.paused === p) return; this.paused = p; this.input.clearBuffer(); this.events.emit('pauseChanged', { paused: p }); }

  /** Freeze the simulation for `seconds` of real time (impact pause). Overlapping calls keep the longest. */
  hitstop(seconds) { if (this.settings.hitPause === false) return; this._hitstopT = Math.max(this._hitstopT, seconds); }
  /** Scale simulation speed to `scale` for `seconds` of real time, then ease back to 1. */
  slowmo(scale, seconds) { this.timeScale = scale; this._slowT = seconds; }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
    this.renderer.shadowMap.enabled = !!this.settings.shadows;
    this.resize();
    this.events.emit('settingsChanged', this.settings);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * (this.settings.pixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    for (const s of this.systems) if (s.onResize) s.onResize(w, h);
  }

  start() { this._last = performance.now(); requestAnimationFrame(this._loop); }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const raw = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.realTime += raw;
    if (raw > 0) this.fps += (1 / Math.max(raw, 1e-4) - this.fps) * 0.05;
    this.frame++;
    this.input.poll();

    // slow motion recovery (real time)
    if (this._slowT > 0) { this._slowT -= raw; if (this._slowT <= 0) this.timeScale = 1; }

    const run = this.running;
    if (run) {
      if (this._hitstopT > 0) {
        this._hitstopT -= raw;
      } else {
        this._acc += raw * this.timeScale;
        let steps = 0;
        while (this._acc >= SIM_DT && steps < 12) {
          this.time += SIM_DT;
          this.simSteps++;
          for (const s of this.systems) {
            if (!s.fixedUpdate || !s.__inited) continue;
            try { s.fixedUpdate(SIM_DT); } catch (e) { this._err(s, 'fixedUpdate', e); }
          }
          this._acc -= SIM_DT;
          steps++;
        }
        if (steps === 12) this._acc = 0; // spiral-of-death guard
      }
    }
    this.alpha = run ? this._acc / SIM_DT : 1;
    for (const s of this.systems) {
      if (!s.update || !s.__inited || (!run && !s.runWhenPaused)) continue;
      try { s.update(raw, this.alpha); } catch (e) { this._err(s, 'update', e); }
    }
    try { this.renderer.render(this.scene, this.camera); } catch (e) { this._err({ __name: 'renderer' }, 'render', e); }
  }

  _err(sys, phase, e) {
    this._errSeen = this._errSeen || new Set();
    const key = `${sys.__name}:${phase}:${e && e.message}`;
    if (this._errSeen.has(key)) return;
    this._errSeen.add(key);
    console.error(`[${sys.__name}] ${phase} error:`, e);
  }

  _makeDebug() {
    const game = this;
    return {
      stats() {
        const info = game.renderer.info;
        const p = game.player;
        return {
          fps: Math.round(game.fps), state: game.state, paused: game.paused, ui: [...game._ui],
          time: +game.time.toFixed(2), drawCalls: info.render.calls, triangles: info.render.triangles,
          geometries: info.memory.geometries, textures: info.memory.textures,
          player: p ? { hp: p.health, stamina: p.stamina && +p.stamina.toFixed?.(1), stance: p.stance, state: p.state, pos: p.position && p.position.toArray().map((v) => +v.toFixed(2)) } : null,
          fighters: game.combat && game.combat.fighters ? game.combat.fighters.length : null,
          chapter: game.flow ? game.flow.chapterId : null,
        };
      },
    };
  }
}
