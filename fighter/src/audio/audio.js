// AudioSystem (system `audio`, FIGHTER.md §10). Fully synthesised WebAudio.
//
// GRAPH:  sfx voices -> sfxBus ─┐
//         music layers -> musicFilter (focus / death low-pass) -> musicDuck (dialogue, pause, UI) -> musicVol ─┤
//         per-voice reverb sends -> convolver (per-chapter room IR) -> revOut ─────────────────────────────────┤
//                                                                   master (settings.volume) -> muffle (pause) -> compressor -> out
// The context is created on unlock() (first gesture; tests call it through game.debug.sfx). Sounds are rendered
// offline (sfx.js) in idle time after init, so play() only wires a buffer source: play(name, { position, volume,
// pitch, delay, pan, reverb }).
// AUTOMATIC SOUNDS from combat events: whooshes timed so their peak lands on the strike (polled at sim rate from
// attackStart, so charge holds / hitstop / slow motion stay in sync), hits by weight / height / limb, blocks, guard
// breaks, parries, absorbs, avoids, stance switches, feints, knockdowns (on the body landing), deaths, focus in/out,
// footsteps from fighter movement (cadence by speed, surface per chapter), enemy telegraphs ('tell' / 'tell_heavy' for
// guard breakers, knockdowns and signatures; one cue per fighter per 0.3 s), charge holds (a rising strain cue from
// chargeStart to chargeRelease / chargeCancel, a tick on chargeFull). MUSIC: see music.js; intensity follows
// encounter events with a polling fallback (enemies near the player / a boss alive), ducks during dialogue.
import { SFX, renderSfx, WHOOSH_PEAK, CONTRACT_SOUNDS } from './sfx.js';
import { Music } from './music.js';
import { THEMES } from './themes.js';
import { impulseResponse, SR } from './dsp.js';

const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
const NO_OPTS = Object.freeze({});
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const KICK = /^(foot|knee)/;
/** Background render order: combat first (short), long one-shots last. */
const GEN_FIRST = ['hit_light', 'hit_body', 'hit_face', 'hit_heavy', 'whoosh_light', 'whoosh_heavy', 'tell', 'tell_heavy', 'block', 'step_stone',
  'step_tile', 'step_mat', 'step_wet', 'dodge', 'parry', 'guard_break', 'absorb', 'avoid', 'stance', 'charge', 'charge_full', 'land', 'knockdown',
  'feint', 'ui_move', 'ui_select', 'ui_back', 'death', 'focus_in', 'focus_out', 'heal', 'gate', 'learned', 'victory',
  'boss_sting', 'age_up'];

export class AudioSystem {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.enabled = typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    this.ctx = null;
    this.unlocked = false;
    this.data = new Map();        // name -> Float32Array[] (rendered variants)
    this.buffers = new Map();     // name -> AudioBuffer[]
    this.music = new Music();
    this.surface = 'stone';
    this.themeId = null;
    this.voices = 0;
    this.maxVoices = 40;
    this.counts = Object.create(null);
    this._lastT = Object.create(null);
    this._lastVar = Object.create(null);
    this._warned = new Set();
    this._fs = new Map();         // fighter -> per-fighter state (footsteps, whoosh timing, landing fallback)
    this._pan = 0;
    this._po = { position: null, volume: 1, pitch: 1, delay: 0 };   // reusable opts for sim-rate plays
    this._lastGain = null;        // gain node of the latest play() (sustained cues fade it out on stop)
    this._hp = null;              // scratch Vector3 (cloned lazily from a fighter position)
    this._genQueue = [];
    this._genIdx = 0;
    this._genTimer = 0;
    this._duckUntil = 0;          // real time (game.realTime) until which dialogue ducks the music
    this._bossFight = false;
    this._fightUntil = 0;
    this._focusOn = false;
    this._levelOverride = -1;     // debug / scripted: forced music level (-1 = automatic)
    this._themeOverride = null;   // debug / scripted: forced theme id
    this._levelT = 0;
    this._padT = 0;
    this._cur = { vol: -1, music: -1, duck: -1, muffle: -1, mfilter: -1 };
    this._ended = () => { this.voices = Math.max(0, this.voices - 1); };
    this._onGesture = () => this.unlock();
    this._onVisibility = () => this._visibility();
  }

  // ============================================================================================ lifecycle

  init() {
    const g = this.game;
    if (typeof window !== 'undefined') {
      for (const ev of GESTURES) window.addEventListener(ev, this._onGesture, { capture: true, passive: true });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
    }
    this._wireEvents();
    this._installDebug();
    // render the bank in idle slices (never blocks loading; play() renders on demand if something is missing)
    for (const name of GEN_FIRST) if (SFX[name]) for (let v = 0; v < SFX[name].variants; v++) this._genQueue.push(name, v);
    for (const name of Object.keys(SFX)) if (!GEN_FIRST.includes(name)) for (let v = 0; v < SFX[name].variants; v++) this._genQueue.push(name, v);
    this._scheduleGen();
    return g;
  }

  _scheduleGen() {
    if (this._genTimer || typeof setTimeout !== 'function') return;
    this._genTimer = setTimeout(() => { this._genTimer = 0; this._genSlice(); }, 30);
  }

  _genSlice() {
    const t0 = performance.now();
    const q = this._genQueue;
    while (this._genIdx < q.length && performance.now() - t0 < 8) {
      const name = q[this._genIdx++], v = q[this._genIdx++];
      this._render(name, v);
    }
    let more = this._genIdx < q.length;
    if (!more && this.ctx && this.music.theme) {
      try { more = this.music.prewarmNext(); } catch (e) { more = false; }
    }
    if (more) this._scheduleGen();
  }

  _render(name, v) {
    let arr = this.data.get(name);
    if (!arr) { arr = []; this.data.set(name, arr); }
    if (!arr[v]) arr[v] = renderSfx(name, v, SR);
    return arr[v];
  }

  /** Create / resume the AudioContext. Safe to call any number of times (first user gesture, menus, tests). */
  unlock() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) this._createContext();
      const c = this.ctx;
      if (c && c.state === 'suspended' && (typeof document === 'undefined' || !document.hidden)) {
        const p = c.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      this.unlocked = true;
      if (c && c.state === 'running' && typeof window !== 'undefined') {
        for (const ev of GESTURES) window.removeEventListener(ev, this._onGesture, { capture: true });
      }
      return c ? c.state : false;
    } catch (e) {
      this.enabled = false;
      return false;
    }
  }

  _createContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.002; comp.release.value = 0.18;
    const muffle = (this.muffle = ctx.createBiquadFilter());
    muffle.type = 'lowpass'; muffle.frequency.value = 20000; muffle.Q.value = 0.5;
    const master = (this.master = ctx.createGain());
    master.connect(muffle); muffle.connect(comp); comp.connect(ctx.destination);
    this.sfxBus = ctx.createGain(); this.sfxBus.connect(master);
    this.musicVol = ctx.createGain(); this.musicVol.connect(master);
    this.musicDuck = ctx.createGain(); this.musicDuck.connect(this.musicVol);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 20000; this.musicFilter.Q.value = 0.6;
    this.musicFilter.connect(this.musicDuck);
    this.reverb = ctx.createConvolver();
    this.revOut = ctx.createGain(); this.revOut.gain.value = 0.9;
    this.reverb.connect(this.revOut); this.revOut.connect(master);
    this.revIn = ctx.createGain(); this.revIn.connect(this.reverb);
    this.music.attach(ctx, this.musicFilter, this.revIn);
    this._cur.vol = this._cur.music = this._cur.duck = this._cur.muffle = this._cur.mfilter = -1;
    this._applyMix(true);
    this._setTheme(this._themeFor(), true);
  }

  _visibility() {
    const c = this.ctx;
    if (!c) return;
    try {
      if (document.hidden) { if (c.state === 'running') c.suspend(); }
      else if (this.unlocked && c.state === 'suspended') { const p = c.resume(); if (p && p.catch) p.catch(() => {}); }
    } catch (e) { /* ignore */ }
  }

  // ============================================================================================ play

  /**
   * Play a sound by name. opts: { position (world, attenuated + panned from the camera), volume, pitch, delay (s),
   * pan, reverb (send override) }. 'step' plays the current surface's footstep. Returns the source node or null.
   */
  play(name, opts) {
    const c = this.ctx;
    if (!c || c.state === 'closed') return null;
    const key = name === 'step' ? 'step_' + this.surface : name;
    const def = SFX[key];
    if (!def) {
      if (!this._warned.has(name)) { this._warned.add(name); console.warn('[audio] unknown sound', name); }
      return null;
    }
    const o = opts || NO_OPTS;
    if (this.voices >= this.maxVoices && (def.prio === 0 || this.voices >= this.maxVoices + 12)) return null;
    const bufs = this._buffers(key);
    if (!bufs || !bufs.length) return null;
    const now = c.currentTime;
    let vi = (Math.random() * bufs.length) | 0;
    if (bufs.length > 1 && vi === this._lastVar[key]) vi = (vi + 1) % bufs.length;
    this._lastVar[key] = vi;
    let vol = def.vol * (typeof o.volume === 'number' ? o.volume : 1);
    const lt = this._lastT[key];
    if (lt !== undefined && now - lt < (def.throttle || 0.03)) vol *= 0.55;   // stacked triggers do not phase / clip
    this._lastT[key] = now;
    let rate = (typeof o.pitch === 'number' && o.pitch > 0 ? o.pitch : 1) * (1 + (Math.random() * 2 - 1) * 0.035);
    const ts = this.game.timeScale;
    if (def.combat && typeof ts === 'number' && ts < 0.98) rate *= 0.72 + 0.28 * clamp(ts, 0, 1);   // slow motion deepens combat
    let pan = typeof o.pan === 'number' ? o.pan : 0;
    if (o.position && !def.ui) {
      const k = this._spatial(o.position);
      if (k < 0) return null;
      vol *= k;
      pan = this._pan;
    }
    if (!(vol > 0.004)) return null;
    const src = c.createBufferSource();
    src.buffer = bufs[vi];
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(g);
    let tail = g;
    if (pan) {
      const p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(this.sfxBus);
    const rev = typeof o.reverb === 'number' ? o.reverb : def.rev;
    if (rev > 0 && this.revIn) {
      const s = c.createGain();
      s.gain.value = rev;
      tail.connect(s);
      s.connect(this.revIn);
    }
    this.voices++;
    this._lastGain = g;
    src.onended = this._ended;
    src.start(now + Math.max(0, +o.delay || 0));
    this.counts[key] = (this.counts[key] || 0) + 1;
    return src;
  }

  _buffers(key) {
    let b = this.buffers.get(key);
    if (b) return b;
    const def = SFX[key];
    b = [];
    for (let v = 0; v < def.variants; v++) {
      const data = this._render(key, v);
      if (!data) continue;
      const ab = this.ctx.createBuffer(1, data.length, SR);
      ab.copyToChannel(data, 0);
      b.push(ab);
    }
    this.buffers.set(key, b);
    return b;
  }

  /** Distance gain from the player (or camera) and stereo pan from the camera's right vector. -1 = too far. */
  _spatial(p) {
    const cam = this.game.camera;
    const px = +p.x || 0, py = +p.y || 0, pz = +p.z || 0;
    let dl = 1;
    if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;
      const dx = px - e[12], dy = py - e[13], dz = pz - e[14];
      dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      this._pan = clamp((dx * e[0] + dy * e[1] + dz * e[2]) / dl, -1, 1) * 0.6;
    } else this._pan = 0;
    const pl = this.game.player;
    const d = pl && pl.position ? Math.hypot(px - pl.position.x, pz - pl.position.z) : dl;
    if (!isFinite(d) || d > 32) return -1;
    return 1 / (1 + Math.max(0, d - 1.5) * 0.11);
  }

  // ============================================================================================ events

  _wireEvents() {
    const ev = this.game.events;
    if (!ev || typeof ev.on !== 'function') return;
    const on = (n, fn) => ev.on(n, (e) => { if (this.ctx) fn(e || NO_OPTS); });
    on('attackStart', (e) => this._onAttack(e));
    on('hit', (e) => this._onHit(e));
    on('blocked', (e) => {
      if (e.guardBroken) { this.play('block', { position: e.point || e.defender?.position, volume: 0.6 }); return; }
      const w = e.move?.weight;
      this.play('block', { position: e.point || e.defender?.position, volume: w === 'heavy' ? 1 : w === 'medium' ? 0.85 : 0.7, pitch: w === 'heavy' ? 0.86 : w === 'light' ? 1.08 : 1 });
    });
    on('guardBroken', (e) => this.play('guard_break', { position: e.fighter?.position }));
    on('parried', (e) => {
      this.play('parry', { position: e.point || e.defender?.position });
      this.play('block', { position: e.point || e.defender?.position, volume: 0.35, pitch: 1.2 });
    });
    on('absorbed', (e) => {
      if (e.pierced) this.play('guard_break', { position: e.point || e.defender?.position, volume: 0.55, pitch: 1.15 });
      else this.play('absorb', { position: e.point || e.defender?.position });
    });
    on('avoided', (e) => this.play('avoid', { position: e.defender?.position, volume: e.kind === 'dodge' ? 0.45 : 1, pitch: e.kind === 'dodge' ? 1.15 : 1 }));
    on('stanceChanged', (e) => { if (!e.byMove && e.fighter) this.play('stance', { position: e.fighter.position, volume: e.fighter === this.game.player ? 1 : 0.7 }); });
    on('feint', (e) => this.play('feint', { position: e.fighter?.position }));
    on('enemyTelegraph', (e) => this._onTelegraph(e));
    on('chargeStart', (e) => this._onChargeStart(e));
    on('chargeFull', (e) => { const f = e.fighter; if (f && f.position) this.play('charge_full', this._o(f.position, f === this.game.player ? 0.9 : 0.75, 1)); });
    on('chargeRelease', (e) => { const st = e.fighter && this._fs.get(e.fighter); if (st) this._stopCharge(st, 0.02); });
    on('chargeCancel', (e) => { const st = e.fighter && this._fs.get(e.fighter); if (st) this._stopCharge(st, 0.03); });
    on('defend', (e) => { if (e.kind === 'avoid_jump') this.play('land', { position: e.fighter?.position, volume: 0.5, delay: 0.38 }); });
    // landing sound: FX reports the body reaching the floor ('bodyLanded'); a timer is the fallback without FX
    on('knockdown', (e) => { const st = e.fighter && this._state(e.fighter); if (st) { st.landAt = this.game.time + 0.95; st.landKind = 'knockdown'; } });
    on('fighterDied', (e) => {
      const f = e.fighter;
      if (!f) return;
      this.play('death', { position: f.position, volume: f === this.game.player ? 1 : 0.7 });
      const st = this._state(f);
      // already lying (died on the floor): no second thud
      let lying = false;
      if (f.animator && typeof f.animator.strikePoint === 'function' && f.position) {
        try { lying = f.animator.strikePoint('hips', this._hp || (this._hp = f.position.clone())).y - (f.position.y || 0) < 0.4; } catch (err) { lying = false; }
      }
      if (lying) st.landedT = this.game.time;
      else if (!(st.landAt > 0 && st.landKind === 'knockdown')) { st.landAt = this.game.time + 1.15; st.landKind = 'death'; }
    });
    on('bodyLanded', (e) => {
      const f = e.fighter;
      const st = f && this._fs.get(f);
      if (st && this.game.time - st.landedT < 0.6) return;    // the fallback already played it
      const kind = e.kind || (st && st.landKind) || 'knockdown';
      if (st) { st.landAt = 0; st.landedT = this.game.time; }
      this._landSound(f, kind, e.point);
    });
    on('focusReady', (e) => { if (e.fighter === this.game.player) { this.play('focus_in'); this._focusOn = true; } });
    on('focusDenied', (e) => { if (e.fighter === this.game.player) this.play('ui_back', { volume: 0.6 }); });
    on('learned', () => this.play('learned'));
    on('absorbHeal', (e) => this.play('heal', { position: e.fighter?.position }));
    on('bossIntro', () => { this._bossFight = true; this.play('boss_sting'); this.music.setLevel(3); this._duck(4); });
    on('bossPhase', (e) => { this.music.setPhase(e.phase || 2); this.play('boss_sting', { volume: 0.4, pitch: 1.12 }); });
    on('bossDefeated', () => { this._bossFight = false; this._fightUntil = 0; this.play('victory'); this.music.setLevel(1); });
    on('roomStarted', () => { this._fightUntil = this.game.realTime + 6; if (!this._bossFight) this.music.setLevel(2); });
    on('roomCleared', () => { this._fightUntil = 0; if (!this._bossFight) this.music.setLevel(1); });
    on('chapterStart', (e) => { this._bossFight = false; this._musicStopped = false; this._setTheme(e.chapterId || this._themeFor()); });
    on('worldLoaded', (e) => { if (this.game.state === 'playing') this._setTheme(e.chapterId || this._themeFor()); });
    on('playerAged', () => this.play('age_up'));
    on('gameOver', () => { this.play('age_up', { pitch: 0.8, volume: 1 }); this.music.stop(2.5); this._musicStopped = true; });
    on('gameStart', () => { this._musicStopped = false; });
    on('dialogue', (e) => this._duck(1.2 + Math.min(5, ((e.text && e.text.length) || 40) * 0.05)));
    on('settingsChanged', () => this._applyMix(false));
  }

  _duck(seconds) { this._duckUntil = Math.max(this._duckUntil, (this.game.realTime || 0) + seconds); }

  _state(f) {
    let st = this._fs.get(f);
    if (!st) {
      st = { x: f.position ? f.position.x : 0, z: f.position ? f.position.z : 0, dist: 0.4, speed: 0, wMove: null, wHits: null,
        wT: 0.2, wIdx: 0, wName: 'whoosh_light', wRate: 1, wVol: 1, wLead: 0.08, landAt: 0, landKind: 'knockdown', landedT: -1e9,
        tellT: -1e9, chSrc: null, chGain: null };
      this._fs.set(f, st);
    }
    return st;
  }

  _onAttack(e) {
    const f = e.fighter, m = e.move;
    if (!f || !m) return;
    const st = this._state(f);
    const info = f.atk && f.atk.move === m ? f.atk.info : null;
    st.wMove = m;
    st.wHits = info && info.hits && info.hits.length ? info.hits : (Array.isArray(m.hits) && m.hits.length ? m.hits : null);
    st.wT = typeof m.startup === 'number' ? m.startup : 0.2;
    st.wIdx = 0;
    const w = e.focus ? 'heavy' : m.weight || 'light';
    const kick = KICK.test(m.limb || '');
    let name = 'whoosh_light', rate = 1.1, vol = 0.8;
    if (w === 'medium') { name = kick ? 'whoosh_heavy' : 'whoosh_light'; rate = kick ? 1.18 : 0.9; vol = 0.9; }
    else if (w === 'heavy') { name = 'whoosh_heavy'; rate = kick ? 0.9 : 1.0; vol = 1; }
    else if (kick) rate = 0.94;
    if (m.path === 'thrust') rate *= 1.07;
    if (f !== this.game.player) vol *= 0.85;
    st.wName = name; st.wRate = rate; st.wVol = vol;
    st.wLead = (WHOOSH_PEAK[name] || 0.08) / rate;
  }

  /**
   * Enemy telegraph (the guard drops into a wind-up): one cue per fighter per 0.3 s. Guard breakers, knockdowns, heavy
   * and signature moves get the heavier cue (an inhale + the weight dropping); counter telegraphs stay very quiet.
   */
  _onTelegraph(e) {
    const f = e.fighter;
    if (!f || !f.position) return;
    const st = this._state(f);
    const now = this.game.time;
    if (now - st.tellT < 0.3) return;
    st.tellT = now;
    const pr = e.move && e.move.props;
    const big = !!(e.heavy || e.signature || (pr && (pr.break || pr.knockdown)));
    if (e.counter) this.play('tell', this._o(f.position, 0.12, 1.08));
    else if (big) this.play('tell_heavy', this._o(f.position, 0.5, 1));
    else this.play('tell', this._o(f.position, 0.35, 1));
  }

  /** Charge hold: a rising strain cue on the charging fighter, faded out on release / cancel. */
  _onChargeStart(e) {
    const f = e.fighter;
    if (!f || !f.position) return;
    const st = this._state(f);
    this._stopCharge(st, 0.02);
    const src = this.play('charge', this._o(f.position, f === this.game.player ? 0.85 : 0.7, 1));
    if (src) { st.chSrc = src; st.chGain = this._lastGain; }
  }

  _stopCharge(st, tau) {
    const src = st.chSrc, g = st.chGain;
    st.chSrc = null; st.chGain = null;
    if (!src || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      if (g) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, tau); }
      src.stop(t + tau * 6);
    } catch (err) { /* already stopped */ }
  }

  /** Fill the reusable opts bag (sim-rate / event plays without allocating). */
  _o(position, volume = 1, pitch = 1) {
    const o = this._po;
    o.position = position || null; o.volume = volume; o.pitch = pitch; o.delay = 0;
    return o;
  }

  _onHit(e) {
    const pos = e.point || (e.defender && e.defender.position);
    const m = e.move || NO_OPTS;
    const w = e.focus ? 'heavy' : e.weight || (e.heavy ? 'heavy' : m.weight || 'light');
    const kick = KICK.test(e.limb || m.limb || '');
    const high = (e.height || m.height) === 'high';
    const pl = this.game.player;
    const pv = e.attacker === pl || e.defender === pl ? 1 : 0.85;
    let main = high ? 'hit_face' : 'hit_light';
    if (w === 'heavy') main = 'hit_heavy';
    else if (w === 'medium') main = high ? 'hit_face' : 'hit_body';
    this.play(main, this._o(pos, pv, kick ? 0.9 : 1));
    if (kick && main !== 'hit_heavy') this.play('hit_body', this._o(pos, 0.45 * pv, 0.85));
    if (w === 'heavy' && high) this.play('hit_face', this._o(pos, 0.4 * pv, 0.95));
    if (e.counter) this.play('hit_face', this._o(pos, 0.38 * pv, 1.25));
    if (e.killed) this.play('hit_heavy', this._o(pos, 0.6, 0.8));
  }

  _landSound(f, kind, point) {
    const pos = point || (f && f.position);
    if (kind === 'death') this.play('knockdown', this._o(pos, 0.65, 0.92));
    else this.play('knockdown', this._o(pos, f === this.game.player ? 1 : 0.85));
  }

  // ============================================================================================ sim-rate polling

  fixedUpdate(dt) {
    if (!this.ctx) return;
    const cb = this.game.combat;
    const fs = cb && cb.fighters;
    if (!fs) return;
    const now = this.game.time;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f || !f.position) continue;
      const st = this._state(f);
      if (st.wMove) this._whoosh(f, st);
      // charge cue failsafe: the fighter left the hold without a release / cancel event (died, removed, reset)
      if (st.chSrc && !(f.alive && f.state === 'attack' && f.atk && f.atk.charging)) this._stopCharge(st, 0.03);
      this._footsteps(f, st, dt);
      if (st.landAt > 0 && now >= st.landAt) { st.landAt = 0; st.landedT = now; this._landSound(f, st.landKind, null); }
    }
    if ((this.game.simSteps & 511) === 0) this._prune();
  }

  /** Start the whoosh so its peak lands on the strike (lead = recipe peak / playback rate). */
  _whoosh(f, st) {
    if (f.state !== 'attack' || f.move !== st.wMove) { st.wMove = null; return; }
    if (f.atk && f.atk.charging) return;
    const n = st.wHits ? st.wHits.length : 1;
    if (st.wIdx >= n) { st.wMove = null; return; }
    const ht = st.wHits ? st.wHits[st.wIdx].t : st.wT;
    if (f.moveTime >= ht - st.wLead) {
      this.play(st.wName, this._o(f.position, st.wVol * (st.wIdx > 0 ? 0.85 : 1), st.wRate));
      st.wIdx++;
    }
  }

  _footsteps(f, st, dt) {
    const p = f.position;
    const dx = p.x - st.x, dz = p.z - st.z;
    st.x = p.x; st.z = p.z;
    if (!f.alive) return;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 0.3) return;                       // teleport / respawn
    st.speed += (d / dt - st.speed) * 0.15;
    const s = f.state;
    const ground = s === 'idle' || s === 'move' || s === 'block' || s === 'switch';
    if (!ground || st.speed < 0.45) { if (st.dist > 0.4) st.dist = 0.4; return; }
    st.dist += d;
    const run = st.speed > 3.4;
    const stride = run ? 1.2 : 0.8;
    if (st.dist < stride) return;
    st.dist -= stride;
    const pl = this.game.player;
    const mine = f === pl;
    if (!mine && pl && pl.position && Math.abs(p.x - pl.position.x) + Math.abs(p.z - pl.position.z) > 22) return;
    const vol = (run ? 0.95 : Math.min(0.85, 0.5 + st.speed * 0.1)) * (mine ? 1 : 0.7) * (s === 'block' ? 0.7 : 1);
    this.play('step', this._o(p, vol, run ? 1.04 : 1));
  }

  _prune() {
    for (const f of this._fs.keys()) if (!f || f.removed) this._fs.delete(f);
  }

  // ============================================================================================ per frame

  update(dt) {
    const g = this.game;
    if (!this.ctx) {
      // a gamepad press may count as a gesture in some browsers: try once per press
      const inp = g.input;
      if (inp && inp.padConnected && typeof inp.pressed === 'function' && (inp.pressed('confirm', true) || inp.pressed('light', true) || inp.pressed('pause', true))) this.unlock();
      return;
    }
    if (this.ctx.state !== 'running') return;
    const m = this.music;
    // theme + intensity (event hints with a polling fallback)
    const theme = this._themeFor();
    if (theme && theme !== this.themeId) this._setTheme(theme, false);
    this._levelT -= dt;
    if (this._levelT <= 0) {
      this._levelT = 0.3;
      const lvl = this._levelOverride >= 0 ? this._levelOverride : this._musicStopped ? 0 : this._desiredLevel();
      if (lvl > 0 && !m.running) { m.start(); m.setLevel(lvl, true); }
      else if (m.running && lvl !== m.level && lvl !== m.pendingLevel) m.setLevel(lvl);
    }
    m.update();
    // focus out: the slow motion ended
    if (this._focusOn && !(g.timeScale < 0.98)) { this._focusOn = false; this.play('focus_out'); }
    this._applyMix(false);
  }

  _themeFor() {
    const g = this.game;
    if (this._themeOverride && THEMES[this._themeOverride]) return this._themeOverride;
    if (g.state === 'title' || g.state === 'loading') return 'title';
    const id = (g.flow && g.flow.chapterId) || (g.world && g.world.chapterId) || 'laundromat';
    return THEMES[id] ? id : 'laundromat';
  }

  _setTheme(id, force) {
    if (!id || (!force && id === this.themeId)) return;
    this.themeId = id;
    const th = THEMES[id] || THEMES.laundromat;
    this.surface = th.surface || 'stone';
    if (!this.ctx) return;
    this.music.setTheme(id);
    this._scheduleGen();
    // per-chapter room acoustics
    try {
      const [L, R] = impulseResponse({ ...th.room, seed: (th.seed || 1) + 3 }, SR);
      const ir = this.ctx.createBuffer(2, L.length, SR);
      ir.copyToChannel(L, 0); ir.copyToChannel(R, 1);
      this.reverb.buffer = ir;
      const t = this.ctx.currentTime;
      this.revOut.gain.setTargetAtTime(clamp((th.room.wet || 0.12) / 0.15, 0.2, 1.4), t, 0.3);
    } catch (e) { /* reverb is optional */ }
  }

  _desiredLevel() {
    const g = this.game;
    if (g.state === 'title') return 1;
    if (g.state !== 'playing') return 0;
    const cb = g.combat, p = g.player;
    let near = false, boss = false;
    const fs = cb && cb.fighters;
    if (fs && p && p.position) {
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        if (!f || f.team === 'player' || !f.alive || f.removed || !f.position) continue;
        const dx = f.position.x - p.position.x, dz = f.position.z - p.position.z;
        if (dx * dx + dz * dz < 196) { near = true; if (f.boss) boss = true; }
      }
    }
    if (boss || this._bossFight) return 3;
    const now = g.realTime || 0;
    if (near) { this._fightUntil = Math.max(this._fightUntil, now + 3); return 2; }
    return now < this._fightUntil ? 2 : 1;
  }

  /** Volume settings, dialogue / pause / UI ducking, focus + death low-pass. Only touches params on change. */
  _applyMix(force) {
    const c = this.ctx;
    if (!c) return;
    const g = this.game, s = g.settings || NO_OPTS, cur = this._cur, t = c.currentTime;
    const vol = clamp(typeof s.volume === 'number' ? s.volume : 0.8, 0, 1);
    const mus = clamp(typeof s.music === 'number' ? s.music : 0.5, 0, 1);
    const mv = vol * vol;
    if (force || Math.abs(mv - cur.vol) > 1e-3) { cur.vol = mv; this.master.gain.setTargetAtTime(mv, t, 0.05); }
    const mm = Math.pow(mus, 1.5) * 0.9;
    if (force || Math.abs(mm - cur.music) > 1e-3) { cur.music = mm; this.musicVol.gain.setTargetAtTime(mm, t, 0.08); }
    const now = g.realTime || 0;
    const uiOpen = !!g.uiOpen;
    let duck = 1;
    if (now < this._duckUntil) duck = 0.42;
    else if (g.paused) duck = 0.55;
    else if (uiOpen) duck = 0.72;
    if (force || duck !== cur.duck) { cur.duck = duck; this.musicDuck.gain.setTargetAtTime(duck, t, duck < 1 ? 0.12 : 0.6); }
    const muffle = g.paused ? 900 : 20000;
    if (force || muffle !== cur.muffle) { cur.muffle = muffle; this.muffle.frequency.setTargetAtTime(muffle, t, 0.08); }
    const p = g.player;
    const slow = typeof g.timeScale === 'number' && g.timeScale < 0.9;
    const dead = !!(p && p.alive === false);
    const mf = dead ? 420 : slow ? 750 : 20000;
    if (force || mf !== cur.mfilter) { cur.mfilter = mf; this.musicFilter.frequency.setTargetAtTime(mf, t, mf < 20000 ? 0.08 : 0.35); }
  }

  // ============================================================================================ API extras

  /**
   * Force the music intensity (0 silent, 1 calm, 2 fight, 3 boss); null / -1 returns to automatic (encounter events +
   * enemies near the player). Optional theme id ('title', 'laundromat', 'market', 'gym', 'tower') or null = automatic.
   */
  setMusicLevel(level, theme) {
    this._levelOverride = typeof level === 'number' && level >= 0 ? Math.min(3, level | 0) : -1;
    if (theme !== undefined) this._themeOverride = theme && THEMES[theme] ? theme : null;
    this._levelT = 0;
    if (this.ctx && this._levelOverride >= 0) {
      if (this._themeOverride) this._setTheme(this._themeOverride, false);
      if (!this.music.running) this.music.start();
      this.music.setLevel(this._levelOverride);
    }
  }
  /** Stop the music (fade). */
  stopMusic(fade = 1.5) { this.music.stop(fade); }

  stats() {
    return {
      enabled: this.enabled, ctx: this.ctx ? this.ctx.state : null, voices: this.voices, rendered: this.data.size,
      queued: (this._genQueue.length - this._genIdx) / 2, surface: this.surface, theme: this.themeId, music: this.music.stats(), counts: { ...this.counts },
    };
  }

  _installDebug() {
    const g = this.game;
    const d = g.debug || (g.debug = {});
    const self = this;
    /** Play a sound by name ('all' plays every contract sound in sequence). Unlocks the context. */
    d.sfx = (name, opts) => {
      self.unlock();
      if (name === 'all') {
        let i = 0;
        const next = () => { if (i < CONTRACT_SOUNDS.length) { self.play(CONTRACT_SOUNDS[i++], opts); setTimeout(next, 120); } };
        next();
        return CONTRACT_SOUNDS.slice();
      }
      return !!self.play(name, opts || {});
    };
    /** Music control: level 0..3 (null = automatic) and optional theme id (null = automatic). */
    d.music = (level, theme) => {
      self.unlock();
      self.setMusicLevel(level, theme);
      return self.music.stats();
    };
    d.audioStats = () => self.stats();
    d.audio = self;
  }
}
