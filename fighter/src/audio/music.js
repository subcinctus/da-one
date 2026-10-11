// Generative chapter music: a lookahead step sequencer (16th notes) that schedules pre-rendered instrument hits on
// the AudioContext clock. Layers (each its own gain, crossfaded on intensity changes at bar boundaries):
//   drone  live bass drone (WebAudio oscillators + slow LFOs + filtered air): no render cost, never hitches
//   perc   taiko-like big drum, shime (small high drum), ka (rim clicks)
//   pluck  Karplus-Strong pentatonic strings: a low ostinato (fight) + an AABA melodic phrase (all levels)
//   boss   kane (small gong), a lower double drum and a live dissonant bowed pad (two saw-like voices a minor
//          second apart, slow tremolo, low-passed)
// Intensity: 0 silent, 1 calm (between rooms), 2 fight, 3 boss. The sequencer allocates WebAudio nodes only when a
// note is scheduled (a few per beat); update() itself allocates nothing.
import { makeBuf, rng, tone, noise, partials, pluck, normalize, highpassDC, mtof, trim, SR } from './dsp.js';
import { taiko } from './sfx.js';
import { THEMES, LAYER_GAINS, patternsFor, vel } from './themes.js';

const TAU = Math.PI * 2;
const LAYERS = ['drone', 'perc', 'pluck', 'boss'];
const SECTION = [0, 0, 1, 0];          // AABA, two bars per letter
const PREWARM_INST = ['taiko', 'shime', 'ka'];
const PREWARM_BOSS = ['kane', 'low'];

function finish(o, peak = 0.88) { highpassDC(o, 22); normalize(o, peak); return trim(o); }

/** Degree index (0 = theme key, may exceed one octave) -> MIDI note. */
export function degreeToMidi(theme, d) {
  const L = theme.scale.length;
  const oct = Math.floor(d / L);
  return theme.key + 12 * oct + theme.scale[((d % L) + L) % L];
}

/** Percussion / boss instrument renderers. */
export const INSTRUMENTS = {
  taiko: (th, r) => finish(taiko(makeBuf(1.4), 0, th.taiko, 1, SR, r)),
  low: (th, r) => finish(taiko(makeBuf(1.6), 0, th.taiko * 0.72, 1, SR, r)),
  shime: (th, r) => {
    const o = makeBuf(0.3);
    tone(o, { f0: 560, f1: 420, glide: 0.006, a: 0.0006, d: 0.07, g: 1 });
    tone(o, { f0: 900, f1: 690, glide: 0.005, a: 0.0006, d: 0.03, g: 0.3 });
    noise(o, { len: 0.06, type: 'bandpass', freq: 2500, q: 1.2, a: 0.0003, d: 0.012, g: 0.6 }, SR, r);
    return finish(o);
  },
  ka: (th, r) => {
    const o = makeBuf(0.08);
    noise(o, { len: 0.06, type: 'bandpass', freq: 1900, q: 5, a: 0.0002, d: 0.012, g: 1 }, SR, r);
    tone(o, { f0: 1150, f1: 1100, a: 0.0003, d: 0.015, g: 0.4 });
    return finish(o);
  },
  kane: (th) => {
    const o = makeBuf(0.75);
    const f = 1250;
    partials(o, { freqs: [f, f * 1.47, f * 2.09, f * 2.56], amps: [0.6, 0.4, 0.3, 0.2], decays: [0.3, 0.2, 0.12, 0.08], beat: 4 });
    return finish(o);
  },
};

/** A plucked string note for a scale degree. */
export function renderNote(theme, deg, seed = 1) {
  const r = rng(theme.seed * 131 + deg * 17 + seed);
  const f = mtof(degreeToMidi(theme, deg));
  const o = makeBuf(2.0);
  pluck(o, { freq: f, len: 2.0, decay: 1.7 * Math.pow(220 / f, 0.35), bright: 0.5 + 0.12 * r(), bend: 0.1 + 0.2 * r(), pos: 0.12 + 0.1 * r(), body: true }, SR, r);
  return finish(o, 0.85);
}

/** A two-bar melodic phrase: degrees (or -1) + velocities on 8th notes, wandering stepwise around the 5th. */
export function makePhrase(seed, density, out = { deg: new Int8Array(32), vel: new Float32Array(32) }) {
  const r = rng(seed);
  out.deg.fill(-1); out.vel.fill(0);
  let d = 7, rest = 0;
  for (let s = 0; s < 32; s += 2) {
    if (rest > 0) { rest--; continue; }
    const p = density * (s % 16 === 0 ? 1.8 : s % 8 === 0 ? 1.3 : s % 4 === 0 ? 1.0 : 0.6);
    if (r() >= p) continue;
    d += [-2, -1, -1, 0, 1, 1, 2][Math.floor(r() * 7)];
    if (s % 16 === 0 && r() < 0.5) d = r() < 0.5 ? 5 : 8;   // lean on tonic / fifth at bar starts
    d = Math.max(5, Math.min(12, d));
    out.deg[s] = d;
    out.vel[s] = 0.45 + 0.3 * r() + (s % 8 === 0 ? 0.1 : 0);
    if (r() < 0.4) rest = 1;                                  // let it ring
  }
  return out;
}

export class Music {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.layers = null;
    this.themeId = null;
    this.theme = null;
    this.level = 0;
    this.pendingLevel = -1;
    this.phase = 1;
    this.running = false;
    this.step = 0;
    this.bar = 0;
    this.nextTime = 0;
    this.stepDur = 0.18;
    this.pat = null;
    this.inst = new Map();     // name -> AudioBuffer (current theme)
    this.notes = new Map();    // degree -> AudioBuffer (current theme)
    this.src = { drone: null, pad: null };    // live voice groups { out, nodes[] }
    this._noise = null;                       // shared 2 s noise loop (air under the drone)
    this._saw = null;                         // PeriodicWave for the bowed pad
    this.phrases = [makePhrase(1, 0), makePhrase(2, 0)];
    this.scheduled = 0;
  }

  /** Connect to an AudioContext. bus = music input node, revSend = reverb send node (optional). */
  attach(ctx, bus, revSend) {
    this.ctx = ctx;
    this.bus = bus;
    this.layers = {};
    for (const name of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(bus);
      this.layers[name] = g;
    }
    if (revSend) {
      const sp = ctx.createGain(); sp.gain.value = 0.26; this.layers.pluck.connect(sp); sp.connect(revSend);
      const sd = ctx.createGain(); sd.gain.value = 0.12; this.layers.perc.connect(sd); sd.connect(revSend);
      const sb = ctx.createGain(); sb.gain.value = 0.2; this.layers.boss.connect(sb); sb.connect(revSend);
    }
  }

  /** Switch to a chapter theme ('title', 'laundromat', 'market', 'gym', 'tower'). */
  setTheme(id) {
    const th = THEMES[id] ? id : 'laundromat';
    if (this.themeId === th) return;
    this.themeId = th;
    this.theme = THEMES[th];
    this.stepDur = 60 / this.theme.bpm / 4;
    this.inst.clear();
    this.notes.clear();
    this.bar = 0;
    this._newPhrases(true);
    this.pat = patternsFor(this.theme, this.level || 1);
    if (this.running) this._startLoops(true);
  }

  /** Start the clock (call after the context runs). */
  start() {
    if (!this.ctx || this.running) return;
    if (!this.theme) this.setTheme('laundromat');
    this.running = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
    this._startLoops(false);
  }

  /** Fade everything out and stop the clock. */
  stop(fade = 1.5) {
    if (!this.ctx) return;
    this.running = false;
    this.level = 0;
    this.pendingLevel = -1;
    this._ramp(0, fade);
    for (const k of ['drone', 'pad']) { this._release(this.src[k], fade); this.src[k] = null; }
  }

  /** Set intensity 0..3; applied on the next bar unless immediate. */
  setLevel(level, immediate = false) {
    const l = Math.max(0, Math.min(3, level | 0));
    if (immediate) { this.pendingLevel = -1; this._applyLevel(l); return; }
    if (l === this.level) { this.pendingLevel = -1; return; }
    this.pendingLevel = l;
  }

  /** Boss phase (2 = more pressure: phrases regenerate denser). */
  setPhase(n) { this.phase = n || 1; this._newPhrases(true); }

  _applyLevel(l) {
    this.level = l;
    if (this.theme) this.pat = patternsFor(this.theme, Math.max(1, l));
    this._ramp(l, l >= 2 ? 0.6 : 1.6);
    this._newPhrases(true);
    if (l === 3 && this.running && !this.src.pad) this._startPad();
    else if (l < 3 && this.src.pad) { this._release(this.src.pad, 2.5); this.src.pad = null; }
  }

  _ramp(level, tc) {
    if (!this.layers) return;
    const g = LAYER_GAINS[level] || LAYER_GAINS[0];
    const now = this.ctx.currentTime;
    for (let i = 0; i < LAYERS.length; i++) {
      const p = this.layers[LAYERS[i]].gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.setTargetAtTime(g[i], now, Math.max(0.05, tc) / 3);
    }
  }

  _newPhrases(both) {
    const th = this.theme;
    if (!th) return;
    const dens = (this.pat ? this.pat.mel : 0.2) * (this.phase >= 2 ? 1.2 : 1);
    const blk = Math.floor(this.bar / 16);
    if (both) makePhrase(th.seed * 1000 + blk * 7 + 1, dens, this.phrases[0]);
    makePhrase(th.seed * 1000 + this.bar * 13 + 5, dens, this.phrases[1]);
  }

  _buffer(data, sr = SR) {
    const b = this.ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data, 0);
    return b;
  }

  _inst(name) {
    let b = this.inst.get(name);
    if (!b) { b = this._buffer(INSTRUMENTS[name](this.theme, rng(this.theme.seed + name.length * 31))); this.inst.set(name, b); }
    return b;
  }

  _note(deg) {
    let b = this.notes.get(deg);
    if (!b) { b = this._buffer(renderNote(this.theme, deg)); this.notes.set(deg, b); }
    return b;
  }

  /** A group of live voices feeding one fade gain. */
  _group(dest, fadeIn) {
    const ctx = this.ctx, now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + fadeIn);
    out.connect(dest);
    return { out, nodes: [] };
  }

  /** Oscillator voice: freq, amp, optional tremolo (lfoHz, depth 0..1), wave (PeriodicWave). */
  _osc(grp, freq, amp, lfoHz = 0, depth = 0, wave = null, phaseDelay = 0) {
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave); else o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = amp * (1 - depth * 0.5);
    o.connect(g); g.connect(grp.out);
    o.start(now + phaseDelay);
    grp.nodes.push(o);
    if (lfoHz > 0 && depth > 0) {
      const l = ctx.createOscillator();
      l.frequency.value = lfoHz;
      const lg = ctx.createGain();
      lg.gain.value = amp * depth * 0.5;
      l.connect(lg); lg.connect(g.gain);
      l.start(now + phaseDelay);
      grp.nodes.push(l);
    }
    return o;
  }

  _release(grp, fade = 2.5) {
    if (!grp || !this.ctx) return;
    const now = this.ctx.currentTime;
    const p = grp.out.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(0, now + fade);
    for (const n of grp.nodes) { try { n.stop(now + fade + 0.05); } catch (e) { /* already stopped */ } }
  }

  _startLoops(crossfade) {
    const ctx = this.ctx;
    const old = this.src.drone;
    // live drone: root + slow beating partner + breathing harmonics + dark air
    const f = mtof(this.theme.drone);
    const grp = this._group(this.layers.drone, crossfade ? 2.5 : 1.5);
    this._osc(grp, f, 0.3);
    this._osc(grp, f + 0.25, 0.18);
    this._osc(grp, f * 2, 0.1, 0.25, 0.5);
    this._osc(grp, f * 1.5, 0.06, 0.125, 0.8);
    this._osc(grp, f * 3, 0.025, 0.375, 1);
    if (!this._noise) {
      const r = rng(17), n = SR * 2, d = new Float32Array(n);
      for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
      this._noise = this._buffer(d);
    }
    const ns = ctx.createBufferSource();
    ns.buffer = this._noise; ns.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.7;
    const ng = ctx.createGain(); ng.gain.value = 0.05;
    ns.connect(lp); lp.connect(ng); ng.connect(grp.out);
    ns.start(ctx.currentTime);
    grp.nodes.push(ns);
    this.src.drone = grp;
    if (old) this._release(old, 2.5);
    if (this.src.pad) { this._release(this.src.pad, 1); this.src.pad = null; }
    if (this.level === 3) this._startPad();
  }

  _startPad() {
    const ctx = this.ctx;
    if (!this._saw) {
      const n = 9, re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) im[k] = 1 / k;
      this._saw = ctx.createPeriodicWave(re, im);
    }
    const f = mtof(this.theme.drone + 12);
    const grp = this._group(this.layers.boss, 2);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.6;
    // voices go through the filter: re-route the group output
    grp.out.disconnect();
    grp.out.connect(lp); lp.connect(this.layers.boss);
    this._osc(grp, f, 0.16, 0.25, 0.6, this._saw);
    this._osc(grp, f * Math.pow(2, 1 / 12), 0.11, 0.375, 0.8, this._saw, 0.3);
    this.src.pad = grp;
  }

  _play(buffer, time, gain, layer, rate = 1, pan = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (rate !== 1) src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p); p.connect(this.layers[layer]);
    } else g.connect(this.layers[layer]);
    src.start(time);
    this.scheduled++;
  }

  /** Schedule notes up to 200 ms ahead (survives frame hitches). Call every frame. */
  update() {
    if (!this.ctx || !this.running || !this.theme) return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.3) this.nextTime = now + 0.05;   // stalled (hidden tab, breakpoint): resync
    let guard = 0;
    while (this.nextTime < now + 0.2 && guard++ < 24) {
      if (this.step % 16 === 0) this._barStart();
      this._step(this.step, this.nextTime);
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % 32;
    }
  }

  _barStart() {
    if (this.pendingLevel >= 0) { const l = this.pendingLevel; this.pendingLevel = -1; this._applyLevel(l); }
    if (this.step === 0) {
      this.bar += 2;
      if (this.bar % 16 === 0) this._newPhrases(true);
      else if (this.bar % 8 === 0) this._newPhrases(false);
    }
  }

  _step(s, T) {
    const P = this.pat;
    if (!P || this.level === 0) return;
    const r = Math.random;
    let v;
    if ((v = vel(P.taiko[s]))) this._play(this._inst('taiko'), T, 0.9 * v, 'perc', 1 + (r() - 0.5) * 0.02, -0.05);
    if ((v = vel(P.shime[s]))) this._play(this._inst('shime'), T, 0.42 * v, 'perc', 1 + (r() - 0.5) * 0.03, -0.3);
    if ((v = vel(P.ka[s]))) this._play(this._inst('ka'), T, 0.4 * v, 'perc', 1 + (r() - 0.5) * 0.04, 0.32);
    if ((v = vel(P.kane[s]))) this._play(this._inst('kane'), T, 0.32 * v, 'boss', 1, 0.2);
    if ((v = vel(P.low[s]))) this._play(this._inst('low'), T, 0.85 * v, 'boss', 1, 0);
    const oc = P.osti.charCodeAt(s) - 48;
    if (oc >= 0 && oc <= 9) this._play(this._note(oc), T, (s % 8 === 0 ? 0.62 : 0.5) * (0.92 + 0.16 * r()), 'pluck', 1, -0.18);
    const ph = this.phrases[SECTION[(this.bar / 2) % 4 | 0]];
    const d = ph.deg[s];
    if (d >= 0) {
      const mv = ph.vel[s];
      // guzheng ornament: a soft grace note from above, just before the beat
      if (r() < 0.14) this._play(this._note(d + 1), Math.max(this.ctx.currentTime, T - this.stepDur * 0.35), mv * 0.35, 'pluck', 1, 0.22);
      this._play(this._note(d), T, mv, 'pluck', 1, 0.2);
    }
  }

  /**
   * Render one missing instrument / note of the current theme (idle-time prewarm, so the sequencer never
   * renders on the beat). Returns true while more work remains.
   */
  prewarmNext() {
    if (!this.ctx || !this.theme) return false;
    for (const n of PREWARM_INST) if (!this.inst.has(n)) { this._inst(n); return true; }
    for (let d = 0; d <= 13; d++) if (!this.notes.has(d)) { this._note(d); return true; }
    for (const n of PREWARM_BOSS) if (!this.inst.has(n)) { this._inst(n); return true; }
    return false;
  }

  /** Debug snapshot. */
  stats() {
    return { theme: this.themeId, level: this.level, pending: this.pendingLevel, running: this.running, bar: this.bar, step: this.step, scheduled: this.scheduled, bpm: this.theme ? this.theme.bpm : 0 };
  }
}
