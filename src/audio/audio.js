// AudioSystem (owned by ATMOSPHERE, see ARCHITECTURE.md §Audio). Everything is synthesised with WebAudio.
//
// Graph:  voices -> sfxIn -> [underwater muffle] -> sfxBus(mute) -> master(settings.volume) -> compressor -> out
//         voices -> world reverb send -> convolver -> sfxIn
//         ui voices -> uiBus -> master                 radio -> musicDuck -> musicBus(musicVolume, mute) -> master
//         ambience -> ambBus(mute) -> master
// API: unlock(), play(name, {position, volume, pitch, intensity, duration}), loop(name, opts) -> {setVolume, setPitch,
//      setPosition, stop}, createEngine(kind) -> {update(rpm01, throttle01, position), setVolume, stop},
//      siren() -> {setPosition, setVolume, setMode, stop}. Radio: radio stations while the player is in a vehicle.
import { Kit, makeImpulse, midiToFreq } from './synth.js';
import { RECIPES, resolveSound, CONTRACT_SOUNDS } from './sounds.js';
import { buildEngine, buildSiren, LOOPS } from './engines.js';
import { Radio, INSTRUMENTS } from './radio.js';
import { Ambient } from './ambient.js';
import { ChaseScore } from './score.js';
import { STATIONS, makeSong, barEvents } from './music.js';
import { BLOCKS, B } from '../world/blocks.js';

const MAX_VOICES = 32;

/** Block id -> footstep surface. */
const SURFACE_OF = (() => {
  const m = {};
  const set = (keys, sf) => { for (const k of keys) if (B[k] !== undefined) m[B[k]] = sf; };
  set(['GRASS', 'LEAVES', 'HEDGE', 'TALL_GRASS', 'FLOWER_RED', 'FLOWER_YELLOW', 'PALM_LEAVES', 'CARPET_RED',
    'WOOL_RED', 'WOOL_BLUE', 'WOOL_YELLOW', 'WOOL_GREEN', 'WOOL_WHITE', 'WOOL_BLACK', 'WOOL_ORANGE', 'WOOL_PURPLE'], 'grass');
  set(['DIRT', 'GRAVEL'], 'dirt');
  set(['SAND', 'SANDSTONE'], 'sand');
  set(['SNOW'], 'snow');
  set(['PLANKS', 'LOG', 'CRATE', 'BOOKSHELF', 'PALM_LOG'], 'wood');
  set(['METAL', 'SOLAR', 'HAZARD'], 'metal');
  set(['GLASS', 'WINDOW', 'WINDOW_LIT'], 'glass');
  set(['WATER'], 'water');
  return m;
})();
const MUSIC_LEVEL = 0.9;
const UI_LEVEL = 0.85;
const AMB_LEVEL = 0.9;
const DEFAULT_RANGE = 80;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const NOOP_HANDLE = Object.freeze({ setVolume() {}, setPitch() {}, setPosition() {}, setMode() {}, update() {}, stop() {} });

export class AudioSystem {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.ctx = null;
    this.kit = null;
    this.unlocked = false;
    this.voices = [];
    this._dying = [];
    this.handles = new Set();
    this.radio = null;
    this.ambient = new Ambient(this);
    this.muted = true;
    this._warned = new Set();
    this._recent = new Map();     // name -> [time, count] (duplicate throttle)
    this._sp = { gain: 1, pan: 0, lp: 0, dist: 0 };
    this._evInVehicle = false;
    this._radioWanted = false;
    this._inVehPrev = false;
    this._forceRadio = false;
    this._underwater = false;
    /** Play a radio station behind the title screen once audio is unlocked. */
    this.titleMusic = true;
    this._titleOn = false;
  }

  init() {
    const g = this.game, ev = g.events;
    if (ev && ev.on) {
      ev.on('settingsChanged', () => this._applySettings());
      ev.on('pauseChanged', () => this._applyMute());
      ev.on('uiChanged', () => this._applyMute());
      ev.on('gameStart', () => { this.unlock(); this._applyMute(); });
      ev.on('vehicleEnter', (e) => { if (this._isPlayer(e && e.character, e)) this._evInVehicle = true; });
      ev.on('vehicleExit', (e) => { if (this._isPlayer(e && e.character, e)) this._evInVehicle = false; });
      ev.on('playerDied', () => { this._evInVehicle = false; });
      ev.on('playerRespawned', () => { this._evInVehicle = false; });
    }
    // Any user gesture unlocks audio (browsers require one); harmless if already unlocked.
    if (typeof window !== 'undefined') {
      const gesture = () => this.unlock();
      for (const t of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(t, gesture, { passive: true });
    }
    if (g.debug) {
      g.debug.sound = (name, opts) => !!this.play(name, opts || {});
      g.debug.radio = (i) => this._debugRadio(i);
      g.debug.audioStats = () => this.stats();
      g.debug.audioAnalyze = (names, seconds) => this.analyze(names, seconds);
      g.debug.radioAnalyze = (bars) => this.analyzeRadio(bars);
      g.debug.chaseMusic = (n) => { this._forceChase = n === null || n === undefined || n < 0 ? undefined : n; return this.score ? this.score.level : null; };
    }
  }

  _isPlayer(ch, e) {
    const p = this.game.player;
    if (!ch) return !!(e && e.vehicle && e.vehicle.driver === 'player');
    return ch === p || ch.kind === 'player';
  }

  /** Create/resume the AudioContext (call from a user gesture). Before this, play() is a silent no-op. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return; } }
    this.ctx = ctx;
    const kit = this.kit = new Kit(ctx);

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;
    this.compressor.connect(ctx.destination);
    this.master = kit.gain(0.7, this.compressor);

    this.sfxBus = kit.gain(0, this.master);
    this.muffle = kit.filter('lowpass', 20000, 0.7, this.sfxBus);
    this.sfxIn = kit.gain(1, this.muffle);
    this.verb = ctx.createConvolver();
    this.verb.buffer = makeImpulse(ctx, 1.5, 3.2, 0.5);
    this.verb.connect(kit.gain(0.55, this.sfxIn));
    this.verbIn = kit.gain(1, this.verb);

    this.uiBus = kit.gain(UI_LEVEL, this.master);
    this.musicBus = kit.gain(0, this.master);
    this.musicDuck = kit.gain(1, this.musicBus);
    this.ambBus = kit.gain(0, this.master);

    this.radio = new Radio(kit, this.musicDuck);
    this.score = new ChaseScore(kit, this.musicDuck);
    this.ambient.build(kit, this.ambBus);
    this.unlocked = true;
    this._applySettings();
    this._applyMute(true);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  _applySettings() {
    if (!this.ctx) return;
    const s = this.game.settings || {};
    const t = this.ctx.currentTime;
    const vol = typeof s.volume === 'number' ? s.volume : 0.7;
    const mus = typeof s.musicVolume === 'number' ? s.musicVolume : 0.5;
    this.master.gain.setTargetAtTime(clamp01(vol), t, 0.03);
    this._musicLevel = clamp01(mus) * MUSIC_LEVEL;
    this._applyMute(true);
  }

  _applyMute(force = false) {
    const g = this.game;
    const muted = g.state !== 'playing' || !!g.paused || !!g.uiOpen;
    const title = g.state === 'title' && this.titleMusic;
    if (!this.ctx) { this.muted = muted; return; }
    if (!force && muted === this.muted && title === this._titleOn) return;
    this.muted = muted;
    this._titleOn = title;
    const t = this.ctx.currentTime;
    const tau = muted ? 0.05 : 0.15;
    this.sfxBus.gain.setTargetAtTime(muted ? 0 : 1, t, tau);
    this.ambBus.gain.setTargetAtTime(muted ? 0 : AMB_LEVEL, t, tau * 3);
    // music stays audible on the title screen (title theme), muted in the pause menu / panels
    this.musicBus.gain.setTargetAtTime(muted && !title ? 0 : (this._musicLevel ?? 0.4), t, tau);
  }

  // ------------------------------------------------------------------------------------------------ spatial
  /** Attenuation + pan for a world position relative to the camera. Returns a shared scratch object or null. */
  _spatial(pos, range) {
    const cam = this.game.camera;
    if (!cam || !pos) { const s = this._sp; s.gain = 1; s.pan = 0; s.lp = 0; s.dist = 0; return s; }
    const c = cam.position;
    const dx = pos.x - c.x, dy = (pos.y ?? c.y) - c.y, dz = pos.z - c.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= range) return null;
    const ref = Math.max(5, range * 0.085);
    const att = 1 / (1 + Math.pow(dist / ref, 1.4));
    const fade = 1 - smoothstep(range * 0.6, range, dist);
    const s = this._sp;
    s.gain = att * fade;
    s.dist = dist;
    s.pan = 0;
    s.lp = 0;
    if (dist > 0.6) {
      const e = cam.matrixWorld.elements;
      const inv = 1 / dist;
      const nx = dx * inv, ny = dy * inv, nz = dz * inv;
      const right = nx * e[0] + ny * e[1] + nz * e[2];
      const fwd = -(nx * e[8] + ny * e[9] + nz * e[10]);
      s.pan = Math.max(-1, Math.min(1, right)) * 0.85 * Math.min(1, dist / 3);
      const behind = fwd < -0.25;
      if (dist > 6 || behind) {
        const k = 1 - dist / range;
        s.lp = Math.min(20000, 700 + 19300 * k * k * k) * (behind ? 0.55 : 1);
      }
    }
    return s;
  }

  // ------------------------------------------------------------------------------------------------ one-shots
  /**
   * Play a sound by name (§4.4). opts: {position?, volume = 1, pitch = 1, intensity?, duration?, range?}.
   * Returns a voice handle {stop()} or null (not unlocked / silent / unknown).
   */
  play(name, opts = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return null;
    const canon = resolveSound(name);
    if (!canon) {
      if (!this._warned.has(name)) { this._warned.add(name); console.warn('[audio] unknown sound:', name); }
      return null;
    }
    const r = RECIPES[canon];
    const o = opts || {};
    let vol = (o.volume ?? 1) * r.gain;
    if (!(vol > 0.0005)) return null;
    const ui = r.bus === 'ui';
    const now = ctx.currentTime;
    let pan = 0, lp = 0, dist = 0;
    const range = o.range ?? r.range ?? DEFAULT_RANGE;
    if (o.position && !ui && !r.global) {
      const sp = this._spatial(o.position, range);
      if (!sp || sp.gain < 0.003) return null;
      vol *= sp.gain; pan = sp.pan; lp = sp.lp; dist = sp.dist;
    }
    // throttle identical sounds fired in the same instant (shotgun pellets, chain explosions)
    const rec = this._recent.get(canon);
    if (rec && now - rec[0] < 0.03) {
      if (rec[1] >= 2) return null;
      rec[1]++;
    } else this._recent.set(canon, [now, 1]);

    this._reap(now);
    // per-name concurrency
    let same = 0, oldestSame = null;
    for (const v of this.voices) if (v.name === canon) { same++; if (!oldestSame || v.start < oldestSame.start) oldestSame = v; }
    if (same >= (r.max || 8) && oldestSame) this._kill(oldestSame);
    // global cap with priority stealing
    if (this.voices.length >= MAX_VOICES) {
      let victim = null;
      for (const v of this.voices) {
        if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.start < victim.start)) victim = v;
      }
      if (victim && victim.prio > (r.prio || 0)) return null;
      if (victim) this._kill(victim);
    }

    const kit = this.kit;
    const input = ctx.createGain();
    input.gain.value = vol;
    const nodes = [input];
    let tail = input;
    if (lp > 0) { const f = kit.filter('lowpass', lp, 0.6); tail.connect(f); tail = f; nodes.push(f); }
    if (pan !== 0 && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; tail.connect(p); tail = p; nodes.push(p); }
    tail.connect(ui ? this.uiBus : this.sfxIn);
    if (!ui && r.verb > 0) {
      const send = kit.gain(r.verb * (0.6 + 0.8 * Math.min(1, dist / 40)), this.verbIn);
      tail.connect(send);
      nodes.push(send);
    }
    // steps / landings pick a surface from the block under the position (unless the caller names one)
    let surface = o.surface;
    if (!surface && (canon === 'footstep' || canon === 'land') && o.position) surface = this._surfaceAt(o.position);
    const jitter = r.jitter || 0;
    const pitch = (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * jitter);
    const sources = [];
    kit.track = sources;
    let dur = 0.5;
    try {
      dur = r.fn(kit, input, now + 0.004, { pitch, intensity: o.intensity ?? 1, duration: o.duration, surface }) || 0.5;
    } catch (e) {
      kit.track = null;
      for (const n of nodes) { try { n.disconnect(); } catch (e2) { /* ignore */ } }
      if (!this._warned.has('fail:' + canon)) { this._warned.add('fail:' + canon); console.warn('[audio] recipe failed:', canon, e); }
      return null;
    }
    kit.track = null;
    const voice = { name: canon, prio: r.prio || 0, start: now, end: now + dur + 0.2, input, nodes, sources, dead: false };
    this.voices.push(voice);
    if (r.duck) this._duck(r.duck);
    return { stop: () => this._kill(voice) };
  }

  /** Surface name for the block under a position (footstep flavour). */
  _surfaceAt(pos) {
    const w = this.game.world;
    if (!w || typeof w.getBlock !== 'function') return null;
    try {
      const x = Math.floor(pos.x), z = Math.floor(pos.z);
      let y = Math.floor(pos.y + 0.05);
      let id = w.getBlock(x, y, z);
      const d0 = BLOCKS[id];
      if (d0 && d0.liquid) return 'water';
      if (!id || (d0 && !d0.solid)) { y -= 1; id = w.getBlock(x, y, z); }
      return SURFACE_OF[id] || 'stone';
    } catch (e) { return null; }
  }

  _duck(seconds) {
    if (!this.musicDuck) return;
    const t = this.ctx.currentTime;
    const p = this.musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(0.25, t + 0.08);
    p.setValueAtTime(0.25, t + seconds);
    p.linearRampToValueAtTime(1, t + seconds + 1.2);
  }

  _kill(v) {
    if (v.dead) return;
    v.dead = true;
    const i = this.voices.indexOf(v);
    if (i >= 0) { this.voices.splice(i, 1); this._dying.push(v); }
    const t = this.ctx.currentTime;
    try {
      v.input.gain.cancelScheduledValues(t);
      v.input.gain.setValueAtTime(v.input.gain.value, t);
      v.input.gain.linearRampToValueAtTime(0, t + 0.03);
    } catch (e) { /* ignore */ }
    for (const s of v.sources) { try { s.stop(t + 0.05); } catch (e) { /* already stopped */ } }
    v.end = t + 0.08;
  }

  _reap(now) {
    for (const list of [this.voices, this._dying]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (now >= v.end) {
          for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
          list.splice(i, 1);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ continuous
  _makeHandle(type, extra) {
    const h = {
      type, built: null, sources: null, out: null, pan: null, lp: null, vol: 1, pitch: 1, pos: null,
      stopped: false, touched: performance.now(), rpm: 0, thr: 0, mode: 'wail', modeTimer: 6 + Math.random() * 4, ...extra,
    };
    this.handles.add(h);
    return h;
  }

  _setPos(h, p) {
    if (!p) { h.pos = null; return; }
    if (!h.pos) h.pos = { x: 0, y: 0, z: 0 };
    h.pos.x = p.x; h.pos.y = p.y ?? 0; h.pos.z = p.z;
  }

  /** Looping sound. Names: horn, tire_screech, fire, rain, wind, tnt_fuse, car_alarm, underwater, siren, engine(_kind)
   *  or any one-shot name (re-triggered). opts: {volume, pitch, position, range}. */
  loop(name, opts = {}) {
    if (name === 'siren') { const s = this.siren(); if (opts.position) s.setPosition(opts.position); return s; }
    const em = /^engine(?:_(car|truck|bike|heli))?$/.exec(name || '');
    if (em) {
      const e = this.createEngine(em[1] || 'car');
      return { setVolume: (v) => e.setVolume(v), setPitch: (p) => e.update(Math.max(0, Math.min(1, p - 1)), 0.3), setPosition: (p) => e.update(undefined, undefined, p), stop: () => e.stop() };
    }
    let type;
    if (LOOPS[name]) type = 'loop';
    else if (resolveSound(name)) type = 'retrigger';
    else {
      if (!this._warned.has('loop:' + name)) { this._warned.add('loop:' + name); console.warn('[audio] unknown loop:', name); }
      return NOOP_HANDLE;
    }
    const h = this._makeHandle(type, { name, range: opts.range ?? (RECIPES[resolveSound(name)]?.range) ?? 60, next: 0 });
    h.vol = opts.volume ?? 1;
    h.pitch = opts.pitch ?? 1;
    this._setPos(h, opts.position);
    return {
      setVolume: (v) => { h.vol = Math.max(0, v); h.touched = performance.now(); },
      setPitch: (p) => { h.pitch = Math.max(0.1, p); },
      setPosition: (p) => { this._setPos(h, p); h.touched = performance.now(); },
      stop: () => this._stopHandle(h),
    };
  }

  /** Vehicle engine voice. kind: 'car' | 'truck' | 'bike' | 'heli'. */
  createEngine(kind = 'car') {
    const h = this._makeHandle('engine', { kind, range: kind === 'heli' ? 160 : kind === 'truck' ? 90 : 75 });
    return {
      update: (rpm01, throttle01, position) => {
        if (typeof rpm01 === 'number' && Number.isFinite(rpm01)) h.rpm = clamp01(rpm01);
        if (typeof throttle01 === 'number' && Number.isFinite(throttle01)) h.thr = clamp01(Math.abs(throttle01));
        if (position) this._setPos(h, position);
        h.touched = performance.now();
      },
      setVolume: (v) => { h.vol = Math.max(0, v); },
      stop: () => this._stopHandle(h),
    };
  }

  /** Police siren (wail with periodic yelp bursts). */
  siren() {
    const h = this._makeHandle('siren', { range: 170 });
    return {
      setPosition: (p) => { this._setPos(h, p); h.touched = performance.now(); },
      setVolume: (v) => { h.vol = Math.max(0, v); },
      setMode: (m) => { h.mode = m === 'yelp' ? 'yelp' : 'wail'; h.forcedMode = true; },
      stop: () => this._stopHandle(h),
    };
  }

  _build(h) {
    const kit = this.kit, ctx = this.ctx;
    const sources = [];
    kit.track = sources;
    try {
      if (h.type === 'engine') h.built = buildEngine(kit, null, h.kind);
      else if (h.type === 'siren') h.built = buildSiren(kit, null);
      else if (h.type === 'loop') h.built = LOOPS[h.name](kit, null);
      else h.built = { out: kit.gain(1) };
    } finally { kit.track = null; }
    h.sources = sources;
    const out = h.built.out;
    h.lp = kit.filter('lowpass', 20000, 0.6);
    h.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    out.connect(h.lp);
    if (h.pan) { h.lp.connect(h.pan); h.pan.connect(this.sfxIn); } else h.lp.connect(this.sfxIn);
    if (h.type === 'siren') { h.verb = kit.gain(0.25, this.verbIn); (h.pan || h.lp).connect(h.verb); }
  }

  _stopHandle(h) {
    if (h.stopped) return;
    h.stopped = true;
    this.handles.delete(h);
    this._teardown(h);
  }

  /** Fade out and release a handle's nodes (it can be rebuilt later unless stopped). */
  _teardown(h) {
    if (!h.built || !this.ctx) { h.built = null; return; }
    const t = this.ctx.currentTime;
    const out = h.built.out;
    try {
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + 0.15);
    } catch (e) { /* ignore */ }
    for (const s of h.sources || []) { try { s.stop(t + 0.2); } catch (e) { /* ignore */ } }
    const lp = h.lp, pan = h.pan, verb = h.verb;
    setTimeout(() => {
      try { out.disconnect(); lp.disconnect(); pan?.disconnect(); verb?.disconnect(); } catch (e) { /* ignore */ }
    }, 400);
    h.built = null; h.lp = null; h.pan = null; h.verb = null; h.sources = null;
  }

  _updateHandles(dt, now) {
    const t = this.ctx.currentTime;
    for (const h of this.handles) {
      if (h.stopped) continue;
      const idle = now - h.touched;
      const sleeper = h.type === 'engine' || h.type === 'siren';
      // engines/sirens nobody updates for a while go to sleep (nodes released) and wake up on the next update
      if (sleeper && idle > 20000) { if (h.built) this._teardown(h); continue; }
      if (!h.built) this._build(h);
      let g = 1, pan = 0, lp = 20000;
      if (h.pos) {
        const sp = this._spatial(h.pos, h.range || DEFAULT_RANGE);
        if (!sp) g = 0; else { g = sp.gain; pan = sp.pan; lp = sp.lp || 20000; }
      }
      if (h.type === 'engine' && idle > 600) g = 0; // not updated recently: fall silent
      const vol = h.vol * g;
      if (h.pan) h.pan.pan.setTargetAtTime(pan, t, 0.05);
      h.lp.frequency.setTargetAtTime(lp, t, 0.08);
      if (h.type === 'engine') h.built.set(h.rpm, h.thr, vol, t);
      else if (h.type === 'siren') {
        if (!h.forcedMode) {
          h.modeTimer -= dt;
          if (h.modeTimer <= 0) {
            h.mode = h.mode === 'wail' ? 'yelp' : 'wail';
            h.modeTimer = h.mode === 'yelp' ? 2.2 + Math.random() * 1.5 : 6 + Math.random() * 5;
            h.built.setMode(h.mode, t);
          }
        }
        h.built.set(vol, t);
      } else if (h.type === 'loop') h.built.set(vol, h.pitch, t);
      else if (h.type === 'retrigger') {
        if (t >= h.next && vol > 0.003) {
          const v = this.play(h.name, { volume: h.vol, pitch: h.pitch, position: h.pos || undefined });
          // re-trigger shortly before the previous copy ends
          const last = v ? this.voices[this.voices.length - 1] : null;
          h.next = last ? Math.max(t + 0.08, last.end - 0.2) : t + 0.25;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ frame
  update(dt) {
    const g = this.game;
    this._applyMute();
    if (!this.ctx) return;
    const now = performance.now();
    const t = this.ctx.currentTime;
    this._reap(t);
    this._updateHandles(dt, now);

    // underwater muffle
    const under = !!(g.sky && g.sky.underwater);
    if (under !== this._underwater) {
      this._underwater = under;
      this.muffle.frequency.setTargetAtTime(under ? 650 : 20000, t, 0.08);
    }

    // radio: on while the player is in a vehicle (or forced by debug), off when paused
    const p = g.player;
    const inVeh = g.state === 'playing' && p && p.alive !== false && (!!p.inVehicle || this._evInVehicle);
    if (inVeh && !this._inVehPrev && this.radio && !this.muted) {
      // just got in: tuning static + station name
      if (this.radio.selected >= 0) {
        this.play('radio_static', { volume: 0.8 });
        g.hud?.notify?.('📻 ' + this.radio.stationName, { duration: 2.5 });
      }
    }
    this._inVehPrev = inVeh;
    if (this.radio) {
      if (inVeh && g.running && g.input && g.input.pressed && g.input.pressed('radio')) {
        const name = this.radio.next();
        this.play('radio_static', { volume: 0.8 });
        g.hud?.notify?.('📻 ' + name, { duration: 2.5 });
      }
      const title = this._titleOn;
      this.radio.setOverride(title ? 0 : -1);
      const want = ((inVeh || this._forceRadio) && !this.muted) || title;
      this.radio.setPower(want);
      this.radio.update(dt);
    }
    // police chase score: builds with the wanted level while the radio is not playing
    if (this.score) {
      const alive = g.state === 'playing' && p && p.alive !== false;
      const wanted = this._forceChase ?? (alive ? (g.police && typeof g.police.wanted === 'number' ? g.police.wanted : 0) : 0);
      const radioPlaying = this.radio && this.radio.on && this.radio.playing >= 0;
      this.score.setLevel(radioPlaying ? 0 : wanted);
      this.score.update(dt, this.muted);
    }
    this.ambient.update(dt, g);
  }

  // ------------------------------------------------------------------------------------------------ debug / tests
  _debugRadio(i) {
    if (!this.ctx) this.unlock();
    if (!this.radio) return null;
    if (i === null || i === undefined || i < 0) {
      this._forceRadio = false;
      this.radio.select(-1);
      return 'off';
    }
    this._forceRadio = true;
    this.radio.select(Math.floor(i) % STATIONS.length);
    this.radio.setPower(!this.muted);
    return this.radio.nowPlaying || this.radio.stationName;
  }

  stats() {
    return {
      state: this.ctx ? this.ctx.state : 'locked',
      voices: this.voices.length,
      handles: this.handles.size,
      muted: this.muted,
      radio: this.radio ? { on: this.radio.on, station: this.radio.stationName, nowPlaying: this.radio.nowPlaying } : null,
      chase: this.score ? { level: this.score.level, active: this.score.active } : null,
      ambient: { ...this.ambient.w },
      time: this.ctx ? +this.ctx.currentTime.toFixed(2) : 0,
    };
  }

  /** Render sounds offline and measure them (peak, rms, length, NaNs). Resolves to {name: {...}}. */
  async analyze(names = CONTRACT_SOUNDS, seconds = 3) {
    const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!OAC) return { error: 'no OfflineAudioContext' };
    const out = {};
    // continuous sources: engines at mid rpm / part throttle and the siren, rendered for `seconds`
    for (const name of ['engine_car', 'engine_truck', 'engine_bike', 'engine_heli', 'siren']) {
      if (names !== CONTRACT_SOUNDS && !names.includes(name)) continue;
      const sr = 22050;
      const ctx = new OAC(1, Math.floor(sr * seconds), sr);
      const kit = new Kit(ctx);
      let b;
      if (name === 'siren') { b = buildSiren(kit, null); b.set(1, 0); }
      else { b = buildEngine(kit, null, name.slice(7)); b.set(0.55, 0.6, 1, 0); }
      b.out.connect(ctx.destination);
      const buf = await ctx.startRendering();
      out[name] = measure(buf.getChannelData(0), seconds);
    }
    for (const name of names) {
      const canon = resolveSound(name);
      if (!canon) { out[name] = { error: 'unknown' }; continue; }
      const sr = 22050;
      const ctx = new OAC(1, Math.floor(sr * seconds), sr);
      const kit = new Kit(ctx);
      const g = ctx.createGain();
      g.gain.value = RECIPES[canon].gain;
      g.connect(ctx.destination);
      let dur = 0;
      try { dur = RECIPES[canon].fn(kit, g, 0.01, { pitch: 1, intensity: 1 }); } catch (e) { out[name] = { error: String(e) }; continue; }
      const buf = await ctx.startRendering();
      out[name] = measure(buf.getChannelData(0), dur);
    }
    return out;
  }

  /** Render a few bars of every station offline (mixing check). */
  async analyzeRadio(bars = 4) {
    const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!OAC) return { error: 'no OfflineAudioContext' };
    const res = {};
    for (const def of STATIONS) {
      const song = makeSong(def, 12345);
      const sr = 22050;
      const startBar = song.sections.find((s) => s.type === 'B')?.start ?? 2;
      const len = bars * song.barDur + 1;
      const ctx = new OAC(1, Math.floor(sr * len), sr);
      const kit = new Kit(ctx);
      const dry = ctx.createGain(); dry.gain.value = def.gain ?? 1; dry.connect(ctx.destination);
      const sends = { dry, verb: ctx.createGain(), delay: ctx.createGain() };
      const perInst = {};
      for (let b = 0; b < bars; b++) {
        for (const e of barEvents(song, startBar + b)) {
          const fn = INSTRUMENTS[e.inst];
          if (!fn) { perInst[e.inst] = 'MISSING'; continue; }
          perInst[e.inst] = (perInst[e.inst] || 0) + 1;
          fn(kit, b * song.barDur + e.step * song.stepDur + 0.01, e.midi ? midiToFreq(e.midi) : 0, e.len * song.stepDur, e.vel, sends);
        }
      }
      const buf = await ctx.startRendering();
      res[def.name] = { ...measure(buf.getChannelData(0), len), bpm: song.bpm, title: song.title, insts: perInst };
    }
    return res;
  }
}

function measure(d, dur) {
  let peak = 0, sum = 0, nan = 0, last = 0;
  for (let i = 0; i < d.length; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (a > 0.001) last = i;
  }
  const rms = Math.sqrt(sum / Math.max(1, d.length));
  return { peak: +peak.toFixed(3), rms: +rms.toFixed(4), audibleUntil: +(last / 22050).toFixed(2), dur: +(+dur).toFixed(2), nan };
}
