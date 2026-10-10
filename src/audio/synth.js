// Synthesis toolkit (owned by ATMOSPHERE): shared noise buffers, waveshaper curves and small node-building helpers
// used by the sound recipes, engines, ambience and the radio. Works with AudioContext and OfflineAudioContext.

/** Fill an AudioBuffer with noise. kind: 'white' | 'pink' | 'brown' | 'crackle'. */
function makeNoise(ctx, seconds, kind) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else if (kind === 'crackle') {
    // sparse random clicks with tiny decays (fire, vinyl, fuse)
    for (let i = 0; i < len; i++) d[i] = 0;
    let i = 0;
    while (i < len) {
      i += Math.floor(ctx.sampleRate * (0.004 + Math.random() * 0.05));
      const amp = Math.pow(Math.random(), 2.2) * (Math.random() < 0.5 ? -1 : 1);
      const dec = 20 + Math.random() * 120;
      for (let k = 0; k < dec && i + k < len; k++) d[i + k] += amp * Math.exp(-k / (dec * 0.25)) * (Math.random() * 2 - 1);
    }
  }
  // fade the loop seam
  const f = Math.min(256, len >> 3);
  for (let i = 0; i < f; i++) { const k = i / f; d[i] *= k; d[len - 1 - i] *= k; }
  return buf;
}

/** Procedural reverb impulse response: stereo decaying noise, darker over time. */
export function makeImpulse(ctx, seconds = 2.2, decay = 2.5, brightness = 0.6) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const w = Math.random() * 2 - 1;
      const a = brightness * (1 - t) + 0.05; // low-pass factor closes over time
      lp += (w - lp) * a;
      d[i] = lp * Math.pow(1 - t, decay);
    }
    // short pre-delay gap for clarity
    for (let i = 0; i < Math.min(len, ctx.sampleRate * 0.012); i++) d[i] = 0;
  }
  return buf;
}

const curveCache = new Map();
/** Soft-clip / distortion curve (cached per amount). */
export function driveCurve(amount = 2) {
  const key = Math.round(amount * 100);
  let c = curveCache.get(key);
  if (c) return c;
  const n = 1024;
  c = new Float32Array(n);
  const k = Math.max(0.01, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  curveCache.set(key, c);
  return c;
}

/** Curve that turns a sine LFO into sharp positive pulses (helicopter blades). */
export function pulseCurve(power = 6) {
  const key = 'p' + power;
  let c = curveCache.get(key);
  if (c) return c;
  const n = 512;
  c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.pow(Math.max(0, x), power); }
  curveCache.set(key, c);
  return c;
}

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Kit: per-context helper. All `t` are absolute context times. `dest` is the node a sound connects into.
 * When `kit.track` is an array, every started source is pushed into it (voice stealing stops them).
 */
export class Kit {
  constructor(ctx) {
    this.ctx = ctx;
    this.white = makeNoise(ctx, 2.0, 'white');
    this.pink = makeNoise(ctx, 2.5, 'pink');
    this.brown = makeNoise(ctx, 3.0, 'brown');
    this.crackle = makeNoise(ctx, 3.0, 'crackle');
    this.track = null;
    this._waves = new Map();
  }

  get now() { return this.ctx.currentTime; }

  _track(src) { if (this.track) this.track.push(src); return src; }

  gain(v = 1, dest = null) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  filter(type, freq, q = 0.707, dest = null) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  shaper(amount, dest = null) {
    const s = this.ctx.createWaveShaper();
    s.curve = driveCurve(amount);
    s.oversample = '2x';
    if (dest) s.connect(dest);
    return s;
  }

  /** Pulse wave with a given duty cycle (0..0.5), as a PeriodicWave (cached). */
  pulseWave(duty = 0.25) {
    const key = Math.round(duty * 1000);
    let w = this._waves.get(key);
    if (w) return w;
    const N = 48;
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) { re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * Math.cos(n * Math.PI * duty) * 2; im[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty) * Math.sin(n * Math.PI * duty) * 2; }
    w = this.ctx.createPeriodicWave(re, im, { disableNormalization: false });
    this._waves.set(key, w);
    return w;
  }

  /** Quantised "NES" triangle wave. */
  nesTriangle() {
    let w = this._waves.get('tri');
    if (w) return w;
    const N = 40;
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n += 2) im[n] = (8 / (Math.PI * Math.PI)) * (((n - 1) / 2) % 2 ? -1 : 1) / (n * n);
    // a touch of even harmonics for the stepped NES flavour
    for (let n = 2; n < N; n += 2) im[n] = 0.012 / n;
    w = this.ctx.createPeriodicWave(re, im);
    this._waves.set('tri', w);
    return w;
  }

  /** Started oscillator. type may be a PeriodicWave. */
  osc(type, freq, t, dur, dest, detune = 0) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.setValueAtTime(Math.max(1, freq), t);
    if (detune) o.detune.setValueAtTime(detune, t);
    if (dest) o.connect(dest);
    o.start(t);
    if (Number.isFinite(dur)) o.stop(t + Math.max(0.01, dur) + 0.05);
    return this._track(o);
  }

  /** Started looping noise source with a random offset. kind: white|pink|brown|crackle. */
  noise(t, dur, dest, kind = 'white', rate = 1) {
    const s = this.ctx.createBufferSource();
    const buf = this[kind] || this.white;
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.setValueAtTime(rate, t);
    s.connect(dest);
    s.start(t, Math.random() * (buf.duration - 0.05));
    if (Number.isFinite(dur)) s.stop(t + Math.max(0.01, dur) + 0.05);
    return this._track(s);
  }

  /** Percussive envelope: quick attack to `peak`, exponential decay to silence over `decay` seconds. */
  perc(param, t, peak, decay, attack = 0.002) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.00001, t);
    param.linearRampToValueAtTime(Math.max(0.00002, peak), t + attack);
    param.exponentialRampToValueAtTime(0.00001, t + attack + Math.max(0.005, decay));
  }

  /** ADSR-ish: attack, hold at peak (with optional decay to sustain), release. Total = a + hold + r. */
  env(param, t, peak, a, hold, r, sustain = 1) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.00001, t);
    param.linearRampToValueAtTime(Math.max(0.00002, peak), t + a);
    if (sustain !== 1) param.exponentialRampToValueAtTime(Math.max(0.00002, peak * sustain), t + a + hold);
    else param.setValueAtTime(Math.max(0.00002, peak), t + a + hold);
    param.exponentialRampToValueAtTime(0.00001, t + a + hold + Math.max(0.005, r));
  }

  /** Pitch/frequency sweep (exponential). */
  sweep(param, t, from, to, dur) {
    param.setValueAtTime(Math.max(1, from), t);
    param.exponentialRampToValueAtTime(Math.max(1, to), t + Math.max(0.005, dur));
  }

  // ---- composites --------------------------------------------------------------------------------------------
  /** Pitched hit: oscillator swept f0->f1 with a percussive envelope. */
  tone(t, o, dest) {
    const g = this.gain(0, dest);
    const osc = this.osc(o.type || 'sine', o.f0, t, (o.attack || 0.002) + o.dur, g, o.detune || 0);
    if (o.f1 && o.f1 !== o.f0) this.sweep(osc.frequency, t, o.f0, o.f1, o.sweep || o.dur);
    this.perc(g.gain, t, o.gain ?? 1, o.dur, o.attack || 0.002);
    return osc;
  }

  /** Filtered noise burst. o: {filter='bandpass', freq, freq1?, q=1, dur, gain=1, attack, kind='white', rate} */
  burst(t, o, dest) {
    const g = this.gain(0, dest);
    const f = this.filter(o.filter || 'bandpass', o.freq, o.q ?? 1, g);
    if (o.freq1) this.sweep(f.frequency, t, o.freq, o.freq1, o.sweep || o.dur);
    this.noise(t, (o.attack || 0.002) + o.dur, f, o.kind || 'white', o.rate || 1);
    this.perc(g.gain, t, o.gain ?? 1, o.dur, o.attack || 0.002);
    return f;
  }

  /** Sustained note with attack/hold/release. o: {type, freq, a, hold, r, gain, detune, sustain} */
  note(t, o, dest) {
    const g = this.gain(0, dest);
    const total = o.a + o.hold + o.r;
    const osc = this.osc(o.type || 'sine', o.freq, t, total, g, o.detune || 0);
    this.env(g.gain, t, o.gain ?? 1, o.a, o.hold, o.r, o.sustain ?? 1);
    return osc;
  }
}
