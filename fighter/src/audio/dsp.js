// Tiny offline DSP toolkit for the procedural sound bank. Pure functions over Float32Array (mono), no WebAudio, so
// every recipe can be unit-tested in node. Everything here runs once at load / chapter start, never per frame.
//
// Layer helpers ADD into an output buffer at a start time (seconds):
//   tone(out, o)    pitched sine / triangle with a pitch glide and an attack/decay envelope (thumps, drums, hums)
//   noise(out, o)   filtered noise (time-varying RBJ biquad) with an envelope (whooshes, slaps, cloth, air)
//   partials(out,o) inharmonic sine partials with individual decays (bells, metal tinks, gongs)
//   pluck(out, o)   Karplus-Strong string (guzheng / koto-like plucks)
//   clicks(out, o)  a burst of micro transients (crunch, crackle, rattles)
// Post: softClip, normalize, fadeOut, highpassDC.

export const SR = 44100;
const TAU = Math.PI * 2;

/** Deterministic PRNG (mulberry32) with helpers. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.bi = () => r() * 2 - 1;
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

/** A zeroed mono buffer of `sec` seconds. */
export function makeBuf(sec, sr = SR) { return new Float32Array(Math.max(1, Math.ceil(sec * sr))); }

/** RBJ cookbook biquad, direct form I. set() may be called while processing (sweeps). */
export class Biquad {
  constructor(type = 'lowpass', freq = 1000, q = 0.707, sr = SR, gainDb = 0) {
    this.sr = sr;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type, freq, q, gainDb);
  }

  set(type, freq, q = 0.707, gainDb = 0) {
    const sr = this.sr;
    const f = Math.min(Math.max(freq, 10), sr * 0.45);
    const w = (TAU * f) / sr, cs = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / (2 * Math.max(q, 1e-3));
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'peak': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      }
      case 'lowpass':
      default: b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Attack (linear) / exponential decay envelope. a, d in seconds (d = time constant). */
export const envAD = (t, a, d) => (t < 0 ? 0 : (a > 0 && t < a ? t / a : 1) * Math.exp(-(a > 0 && t > a ? t - a : t) / Math.max(1e-4, d)));
/** Swell then cut: rises with a power curve to `peak` s, then falls over `fall` s. */
export const envSwell = (t, peak, fall, pow = 2) => (t < 0 ? 0 : t < peak ? Math.pow(t / peak, pow) : Math.max(0, 1 - (t - peak) / Math.max(1e-4, fall)) ** 1.6);

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const val = (v, t, d) => (typeof v === 'function' ? v(t) : num(v, d));

/**
 * Pitched layer. o: { t, len, f0, f1, glide (time const s), a, d, g, wave ('sine'|'tri'), drive, env(t), vib, vibRate }.
 * Frequency glides exponentially from f0 to f1.
 */
export function tone(out, o, sr = SR) {
  const n0 = Math.floor(num(o.t, 0) * sr);
  const len = num(o.len, num(o.d, 0.1) * 7);
  const n = Math.min(out.length - n0, Math.ceil(len * sr));
  if (n <= 0) return out;
  const f0 = num(o.f0, 100), f1 = num(o.f1, f0), glide = Math.max(1e-4, num(o.glide, 0.05));
  const a = Math.max(0, num(o.a, 0.001)), d = Math.max(1e-4, num(o.d, 0.1)), g = num(o.g, 1), drive = num(o.drive, 0);
  const tri = o.wave === 'tri';
  const vib = num(o.vib, 0), vibRate = num(o.vibRate, 5);
  const fade = Math.min(n, Math.ceil(0.004 * sr));
  const envFn = typeof o.env === 'function' ? o.env : null;
  const kGlide = Math.exp(-1 / (glide * sr)), kDec = Math.exp(-1 / (d * sr));
  const na = Math.ceil(a * sr);
  const dk = drive > 0 ? 1 / Math.tanh(drive) : 1;
  let ph = num(o.phase, 0), gl = 1, dec = 1;
  for (let i = 0; i < n; i++) {
    let f = f1 + (f0 - f1) * gl;
    gl *= kGlide;
    if (vib) f *= 1 + vib * Math.sin((TAU * vibRate * i) / sr);
    ph += (TAU * f) / sr;
    let s = tri ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
    let e;
    if (envFn) e = envFn(i / sr);
    else if (i < na) e = i / na;
    else { e = dec; dec *= kDec; }
    s *= e * g;
    if (drive > 0) s = Math.tanh(s * drive) * dk;
    if (i > n - fade) s *= (n - i) / fade;
    out[n0 + i] += s;
  }
  return out;
}

/**
 * Filtered noise layer. o: { t, len, type ('lowpass'|'highpass'|'bandpass'|'none'), freq (Hz or fn(t)), q (or fn),
 * a, d, env(t), g, seed / rand, type2 + freq2 + q2 (optional second filter in series), am (fn(t) amplitude mod) }.
 */
export function noise(out, o, sr = SR, rand = null) {
  const r = rand || rng(num(o.seed, 7));
  const n0 = Math.floor(num(o.t, 0) * sr);
  const len = num(o.len, num(o.d, 0.1) * 7);
  const n = Math.min(out.length - n0, Math.ceil(len * sr));
  const type = o.type || 'bandpass';
  const f1 = type === 'none' ? null : new Biquad(type, val(o.freq, 0, 1000), val(o.q, 0, 0.7), sr);
  const f2 = o.type2 ? new Biquad(o.type2, val(o.freq2, 0, 1000), val(o.q2, 0, 0.7), sr) : null;
  const a = num(o.a, 0.001), d = num(o.d, 0.1), g = num(o.g, 1);
  const varying = typeof o.freq === 'function' || typeof o.q === 'function';
  const varying2 = f2 && (typeof o.freq2 === 'function' || typeof o.q2 === 'function');
  const fade = Math.min(n, Math.ceil(0.003 * sr));
  const envFn = typeof o.env === 'function' ? o.env : null;
  const na = Math.ceil(Math.max(0, a) * sr), kDec = Math.exp(-1 / (Math.max(1e-4, d) * sr));
  let dec = 1;
  // filters lose level at narrow bands: compensate bandpass by sqrt(q)
  const comp = type === 'bandpass' ? Math.sqrt(Math.max(0.5, val(o.q, 0, 0.7))) : 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 15) === 0) {
      if (varying) f1.set(type, val(o.freq, t, 1000), val(o.q, t, 0.7));
      if (varying2) f2.set(o.type2, val(o.freq2, t, 1000), val(o.q2, t, 0.7));
    }
    let s = r() * 2 - 1;
    if (f1) s = f1.process(s) * comp;
    if (f2) s = f2.process(s);
    let e;
    if (envFn) e = envFn(t);
    else if (i < na) e = i / na;
    else { e = dec; dec *= kDec; }
    if (o.am) e *= o.am(t);
    s *= e * g;
    if (i > n - fade) s *= (n - i) / fade;
    out[n0 + i] += s;
  }
  return out;
}

/** Inharmonic partials (bells, tinks, gongs). o: { t, len, freqs[], amps[], decays[], a, g, beat (Hz detune pair) }. */
export function partials(out, o, sr = SR) {
  const fr = o.freqs || [440], am = o.amps || [], de = o.decays || [];
  const beat = num(o.beat, 0);
  for (let k = 0; k < fr.length; k++) {
    const amp = num(am[k], 1 / (k + 1)) * num(o.g, 1);
    const dec = num(de[k], 0.5);
    const len = Math.min(num(o.len, dec * 7), dec * 7), a = num(o.a, 0.0015);
    tone(out, { t: o.t, len, f0: fr[k], f1: fr[k], a, d: dec, g: beat ? amp * 0.5 : amp, phase: k * 1.7 }, sr);
    if (beat) tone(out, { t: o.t, len, f0: fr[k] + beat * (1 + k * 0.3), f1: fr[k] + beat * (1 + k * 0.3), a, d: dec, g: amp * 0.5, phase: k * 0.6 }, sr);
  }
  return out;
}

/**
 * Karplus-Strong pluck. o: { t, freq, len, decay (seconds to -60 dB-ish), bright (0..1 excitation brightness),
 * pos (pluck position 0..0.5), g, bend (semitones of initial pitch bend that relaxes over ~60 ms), body (bool) }.
 */
export function pluck(out, o, sr = SR, rand = null) {
  const r = rand || rng(num(o.seed, 3));
  const freq = Math.min(sr / 4, Math.max(30, num(o.freq, 220)));
  const n0 = Math.floor(num(o.t, 0) * sr);
  const n = Math.min(out.length - n0, Math.ceil(num(o.len, 1.6) * sr));
  if (n <= 0) return out;
  const bright = Math.min(1, Math.max(0, num(o.bright, 0.6)));
  const pos = Math.min(0.5, Math.max(0.02, num(o.pos, 0.18)));
  const per = sr / freq;
  // excitation: one period of noise, low-passed by brightness, comb-filtered by the pluck position
  const exc = new Float32Array(Math.ceil(per));
  const lp = new Biquad('lowpass', 700 + bright * 7500, 0.6, sr);
  for (let i = 0; i < exc.length; i++) exc[i] = lp.process(r() * 2 - 1);
  const off = Math.max(1, Math.floor(per * pos));
  for (let i = exc.length - 1; i >= off; i--) exc[i] -= exc[i - off] * 0.9;
  // loop gain from the decay time: g^(freq * decay) = 0.001 (-60 dB)
  const decay = Math.max(0.05, num(o.decay, 1.2));
  const loopG = Math.pow(0.001, 1 / (freq * decay));
  const damp = 0.5 - 0.25 * (1 - bright); // two-tap average weight (lower = brighter, longer sustain of highs)
  const bend = num(o.bend, 0), g = num(o.g, 1);
  const y = new Float32Array(n);
  const body = o.body ? [new Biquad('peak', 190, 1.1, sr, 5), new Biquad('peak', 560, 1.4, sr, 3)] : null;
  const fadeIn = Math.ceil(0.0015 * sr);
  const kb = Math.exp(-1 / (0.06 * sr));
  let bn = bend;
  for (let i = 0; i < n; i++) {
    // the two-tap average adds `damp` samples of delay: compensate to stay in tune
    let pd = per - damp;
    if (bn > 1e-4 || bn < -1e-4) { pd = per / Math.pow(2, bn / 12) - damp; bn *= kb; }
    const rp = i - pd;
    let fb = 0;
    if (rp >= 1) {
      const i0 = Math.floor(rp), fr = rp - i0;
      const a = y[i0] * (1 - fr) + y[i0 + 1] * fr;
      const b = y[i0 - 1] * (1 - fr) + y[i0] * fr;
      fb = loopG * ((1 - damp) * a + damp * b);
    }
    y[i] = (i < exc.length ? exc[i] : 0) + fb;
    let s = y[i];
    if (body) s = body[1].process(body[0].process(s));
    if (i < fadeIn) s *= i / fadeIn;
    out[n0 + i] += s * g;
  }
  return out;
}

/** A burst of micro transients. o: { t, len, count, freq, q, d (each click decay), g, seed }. */
export function clicks(out, o, sr = SR, rand = null) {
  const r = rand || rng(num(o.seed, 11));
  const count = Math.max(1, num(o.count, 4));
  const len = num(o.len, 0.03);
  for (let k = 0; k < count; k++) {
    const t = num(o.t, 0) + Math.pow(r(), num(o.skew, 1)) * len;
    const amp = num(o.g, 1) * (0.45 + 0.55 * r()) * (1 - (0.5 * k) / count);
    noise(out, { t, len: num(o.d, 0.004) * 6, type: 'bandpass', freq: num(o.freq, 2000) * (0.75 + 0.5 * r()), q: num(o.q, 1.2), a: 0.0002, d: num(o.d, 0.004), g: amp }, sr, r);
  }
  return out;
}

/** Gentle saturation, normalised so a full-scale input stays ~full scale. */
export function softClip(out, drive = 1.5) {
  const k = Math.tanh(drive);
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i] * drive) / k;
  return out;
}

/** Scale so the absolute peak equals `peak`. */
export function normalize(out, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; }
  if (m > 1e-9) { const k = peak / m; for (let i = 0; i < out.length; i++) out[i] *= k; }
  return out;
}

/** Linear fade over the last `sec` seconds (kills clicks at buffer ends). */
export function fadeOut(out, sec = 0.01, sr = SR) {
  const n = Math.min(out.length, Math.ceil(sec * sr));
  for (let i = 0; i < n; i++) out[out.length - 1 - i] *= i / n;
  return out;
}

/** One-pole DC blocker / gentle high-pass (removes sub offsets from asymmetric layers). */
export function highpassDC(out, hz = 25, sr = SR) {
  const R = Math.exp((-TAU * hz) / sr);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < out.length; i++) { const x = out[i]; const y = x - x1 + R * y1; x1 = x; y1 = y; out[i] = y; }
  return out;
}

/** Apply a biquad over the whole buffer (in place). */
export function filter(out, type, freq, q = 0.707, sr = SR, gainDb = 0) {
  const f = new Biquad(type, freq, q, sr, gainDb);
  for (let i = 0; i < out.length; i++) out[i] = f.process(out[i]);
  return out;
}

/** Trim trailing near-silence (keeps buffers short). */
export function trim(out, thresh = 0.0008, sr = SR) {
  let end = out.length;
  while (end > 1 && Math.abs(out[end - 1]) < thresh) end--;
  end = Math.min(out.length, end + Math.ceil(0.005 * sr));
  return end < out.length ? fadeOut(out.slice(0, end), 0.004, sr) : out;
}

/**
 * Stereo room impulse response for a ConvolverNode: exponentially decaying noise that darkens over time,
 * with a short pre-delay and a few early reflections. Returns [left, right].
 */
export function impulseResponse({ sec = 1.0, decay = 0.35, damp = 0.5, pre = 0.012, early = 4, seed = 5 } = {}, sr = SR) {
  const r = rng(seed);
  const n = Math.ceil(sec * sr);
  const chans = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const ch = chans[c];
    const lp = new Biquad('lowpass', 9000, 0.5, sr);
    const p0 = Math.floor(pre * sr);
    for (let i = p0; i < n; i++) {
      const t = (i - p0) / sr;
      if ((i & 63) === 0) lp.set('lowpass', Math.max(500, 9000 * Math.exp((-t * damp * 6) / Math.max(0.05, sec))), 0.5);
      ch[i] = lp.process(r() * 2 - 1) * Math.exp(-t / decay);
    }
    for (let k = 0; k < early; k++) {
      const i = p0 + Math.floor((0.004 + r() * 0.03) * sr);
      if (i < n) ch[i] += (r() < 0.5 ? -1 : 1) * (0.5 + 0.4 * r());
    }
    fadeOut(ch, Math.min(0.1, sec * 0.2), sr);
  }
  // equal energy across channels, unit-ish peak
  let m = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  if (m > 0) for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] /= m;
  return chans;
}

/**
 * Seamless loop: a buffer of exactly `sec` seconds built by `fill(buf, sr)` over sec + xf, whose tail is crossfaded
 * into its head (equal power). Use for drones / pads that contain noise.
 */
export function makeLoop(sec, xf, fill, sr = SR) {
  const n = Math.ceil(sec * sr), nx = Math.ceil(xf * sr);
  const tmp = new Float32Array(n + nx);
  fill(tmp, sr);
  const out = tmp.slice(0, n);
  for (let i = 0; i < nx; i++) {
    const k = i / nx;
    out[i] = tmp[n + i] * Math.cos(k * Math.PI * 0.5) + out[i] * Math.sin(k * Math.PI * 0.5);
  }
  return out;
}

/** Quantise a frequency so it completes a whole number of cycles in `sec` (click-free loops). */
export const loopFreq = (f, sec) => Math.max(1, Math.round(f * sec)) / sec;

/** MIDI note number to Hz. */
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Peak / RMS / NaN check (tests). */
export function stats(out) {
  let peak = 0, sum = 0, nan = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, out.length)), nan, len: out.length };
}
