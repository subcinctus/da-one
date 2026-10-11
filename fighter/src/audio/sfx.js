// The procedural sound bank: one recipe per sound name (FIGHTER.md §10 Audio), rendered offline with dsp.js into a few
// seeded variants each. Recipes are layered like a foley mix: punches = tight low thump + transient click + cloth snap,
// kicks heavier, face hits a sharper slap, blocks a muffled forearm thock, parry a bright metallic tink + air, etc.
//
// Table fields: variants, vol (mix level), rev (reverb send), prio (0 = droppable under voice pressure),
// throttle (s, repeated triggers inside it are attenuated), combat (pitch follows slow motion), ui (never positional).
import { makeBuf, rng, tone, noise, partials, pluck, clicks, softClip, normalize, highpassDC, filter, trim, envAD, envSwell, mtof, SR } from './dsp.js';

const TAU = Math.PI * 2;

/** Rising then falling band sweep helper for whooshes. */
const sweep = (lo, hi, end, peak, fall) => (t) => (t < peak ? lo + (hi - lo) * Math.pow(t / peak, 1.4) : hi + (end - hi) * Math.min(1, (t - peak) / fall));

/** A tremolo whose rate glides from r0 to r1 (Hz) with time constant k (stateful: called with increasing t). */
function glidingTremolo(r0, r1, k, depth) {
  let ph = 0, last = 0;
  return (t) => {
    const dt = Math.max(0, t - last); last = t;
    ph += TAU * (r1 + (r0 - r1) * Math.exp(-t / k)) * dt;
    return 1 - depth + depth * (0.5 + 0.5 * Math.sin(ph));
  };
}

// ------------------------------------------------------------------------------------------------ recipes

function whooshLight(sr, r) {
  const len = 0.2, o = makeBuf(len, sr);
  const peak = 0.085 + r.bi() * 0.006;
  const lo = 650 * (1 + 0.12 * r.bi()), hi = 2300 * (1 + 0.12 * r.bi());
  noise(o, { len, type: 'bandpass', freq: sweep(lo, hi, lo * 1.4, peak, 0.08), q: 1.3, env: (t) => envSwell(t, peak, 0.085, 2.2), g: 1 }, sr, r);
  noise(o, { len, type: 'highpass', freq: 4800, q: 0.7, env: (t) => envSwell(t, peak, 0.05, 3), g: 0.16 }, sr, r);
  noise(o, { len, type: 'lowpass', freq: 380, q: 0.8, env: (t) => envSwell(t, peak * 1.05, 0.07, 2), g: 0.45 }, sr, r);
  return o;
}

function whooshHeavy(sr, r) {
  const len = 0.36, o = makeBuf(len, sr);
  const peak = 0.16 + r.bi() * 0.01;
  const lo = 280 * (1 + 0.1 * r.bi()), hi = 1350 * (1 + 0.1 * r.bi());
  noise(o, { len, type: 'bandpass', freq: sweep(lo, hi, lo * 2, peak, 0.15), q: 1.0, env: (t) => envSwell(t, peak, 0.16, 2.4), g: 1 }, sr, r);
  noise(o, { len, type: 'lowpass', freq: 210, q: 0.9, env: (t) => envSwell(t, peak, 0.14, 2), g: 0.75 }, sr, r);
  // cloth flap riding the swing
  noise(o, { len, type: 'bandpass', freq: 1100, q: 1.4, env: (t) => envSwell(t, peak * 0.95, 0.1, 2.6), am: (t) => 0.55 + 0.45 * Math.sin(TAU * 34 * t), g: 0.3 }, sr, r);
  noise(o, { len, type: 'highpass', freq: 4200, q: 0.7, env: (t) => envSwell(t, peak, 0.06, 3), g: 0.1 }, sr, r);
  return o;
}

function hitLight(sr, r) {
  const o = makeBuf(0.22, sr);
  tone(o, { f0: 170 * (1 + 0.08 * r.bi()), f1: 62, glide: 0.022, a: 0.0008, d: 0.045, g: 1.0, drive: 1.6 }, sr);
  noise(o, { len: 0.012, type: 'highpass', freq: 2600, q: 0.7, a: 0.0002, d: 0.0025, g: 0.9 }, sr, r);              // click
  noise(o, { t: 0.002, len: 0.09, type: 'bandpass', freq: 1700 * (1 + 0.15 * r.bi()), q: 1.6, a: 0.0005, d: 0.018, g: 0.55 }, sr, r); // cloth snap
  noise(o, { len: 0.1, type: 'bandpass', freq: 420 * (1 + 0.1 * r.bi()), q: 2.2, a: 0.0006, d: 0.03, g: 0.6 }, sr, r);  // flesh knock
  return softClip(o, 1.3);
}

function hitBody(sr, r) {
  const o = makeBuf(0.3, sr);
  tone(o, { f0: 135 * (1 + 0.08 * r.bi()), f1: 52, glide: 0.03, a: 0.001, d: 0.09, g: 1.1, drive: 2 }, sr);
  noise(o, { len: 0.16, type: 'bandpass', freq: 300 * (1 + 0.1 * r.bi()), q: 1.8, a: 0.001, d: 0.05, g: 0.75 }, sr, r);
  noise(o, { len: 0.12, type: 'lowpass', freq: 650, q: 0.7, a: 0.0008, d: 0.04, g: 0.5 }, sr, r);
  noise(o, { len: 0.01, type: 'highpass', freq: 1900, q: 0.7, a: 0.0002, d: 0.003, g: 0.5 }, sr, r);
  noise(o, { t: 0.003, len: 0.1, type: 'bandpass', freq: 1300, q: 1.4, a: 0.0005, d: 0.025, g: 0.5 }, sr, r);
  return softClip(o, 1.5);
}

function hitFace(sr, r) {
  const o = makeBuf(0.22, sr);
  noise(o, { len: 0.14, type: 'bandpass', freq: 2600 * (1 + 0.12 * r.bi()), q: 1.1, a: 0.0003, d: 0.03, g: 1.0 }, sr, r);  // slap
  noise(o, { len: 0.12, type: 'bandpass', freq: 950, q: 2, a: 0.0004, d: 0.025, g: 0.7 }, sr, r);                           // smack
  tone(o, { f0: 220, f1: 90, glide: 0.015, a: 0.0006, d: 0.035, g: 0.6, drive: 1.4 }, sr);
  noise(o, { len: 0.008, type: 'highpass', freq: 3500, q: 0.7, a: 0.0001, d: 0.002, g: 0.8 }, sr, r);
  clicks(o, { len: 0.008, count: 3, freq: 3000, q: 1.5, d: 0.002, g: 0.45 }, sr, r);
  return softClip(o, 1.4);
}

function hitHeavy(sr, r) {
  const o = makeBuf(0.5, sr);
  tone(o, { f0: 105 * (1 + 0.06 * r.bi()), f1: 38, glide: 0.04, a: 0.001, d: 0.2, g: 1.2, drive: 2.4 }, sr);
  noise(o, { len: 0.4, type: 'lowpass', freq: 220, q: 0.8, a: 0.001, d: 0.12, g: 0.8 }, sr, r);
  clicks(o, { len: 0.025, count: 6, freq: 1500, q: 0.9, d: 0.005, g: 0.8, skew: 1.4 }, sr, r);                          // crunch
  noise(o, { t: 0.004, len: 0.2, type: 'bandpass', freq: 1200, q: 1.2, a: 0.001, d: 0.05, g: 0.6 }, sr, r);           // cloth
  noise(o, { len: 0.2, type: 'bandpass', freq: 380, q: 1.5, a: 0.001, d: 0.06, g: 0.7 }, sr, r);
  noise(o, { len: 0.012, type: 'highpass', freq: 2000, q: 0.7, a: 0.0002, d: 0.003, g: 0.7 }, sr, r);
  return softClip(o, 1.8);
}

function block(sr, r) {
  const o = makeBuf(0.2, sr);
  tone(o, { f0: 235 * (1 + 0.08 * r.bi()), f1: 150, glide: 0.01, a: 0.0008, d: 0.05, g: 0.9, drive: 1.5 }, sr);
  noise(o, { len: 0.15, type: 'bandpass', freq: 480 * (1 + 0.1 * r.bi()), q: 6, a: 0.0006, d: 0.045, g: 0.55 }, sr, r);  // bone / wood body
  noise(o, { len: 0.1, type: 'lowpass', freq: 900, q: 0.7, a: 0.0005, d: 0.03, g: 0.7 }, sr, r);
  noise(o, { t: 0.002, len: 0.06, type: 'bandpass', freq: 1100, q: 1, a: 0.0005, d: 0.02, g: 0.3 }, sr, r);             // sleeve
  noise(o, { len: 0.008, type: 'highpass', freq: 1500, q: 0.7, a: 0.0001, d: 0.002, g: 0.3 }, sr, r);
  return filter(softClip(o, 1.3), 'lowpass', 2400, 0.7, sr);
}

function guardBreak(sr, r) {
  const o = makeBuf(0.55, sr);
  clicks(o, { len: 0.05, count: 9, freq: 2200, q: 0.8, d: 0.006, g: 1, skew: 1.6 }, sr, r);                          // crack
  noise(o, { len: 0.3, type: 'bandpass', freq: 1600, q: 0.7, a: 0.0005, d: 0.07, am: (t) => (Math.sin(TAU * 95 * t) > 0 ? 1 : 0.35), g: 0.8 }, sr, r);
  tone(o, { f0: 120, f1: 42, glide: 0.03, a: 0.001, d: 0.16, g: 1.1, drive: 2.5 }, sr);
  noise(o, { t: 0.02, len: 0.32, type: 'bandpass', freq: (t) => 1800 - 1300 * Math.min(1, t / 0.3), q: 1.2, env: (t) => envSwell(t, 0.02, 0.3, 1), g: 0.35 }, sr, r);
  return softClip(o, 2);
}

function parry(sr, r) {
  const o = makeBuf(0.9, sr);
  const f = 1900 * (1 + 0.04 * r.bi());
  partials(o, { freqs: [f, f * 2.32, f * 4.25, f * 6.63], amps: [1, 0.55, 0.35, 0.2], decays: [0.42, 0.24, 0.12, 0.06], beat: 3, a: 0.0008 }, sr);
  noise(o, { len: 0.01, type: 'highpass', freq: 4000, q: 0.7, a: 0.0001, d: 0.0015, g: 0.8 }, sr, r);
  noise(o, { len: 0.25, type: 'highpass', freq: 6000, q: 0.7, env: (t) => envSwell(t, 0.015, 0.14, 1.5), g: 0.25 }, sr, r);   // air
  tone(o, { f0: 200, f1: 120, glide: 0.01, a: 0.0006, d: 0.03, g: 0.35 }, sr);
  return o;
}

function absorb(sr, r) {
  const o = makeBuf(0.6, sr);
  tone(o, { f0: 95, f1: 58, glide: 0.03, a: 0.001, d: 0.13, g: 1, drive: 1.5 }, sr);
  noise(o, { len: 0.3, type: 'lowpass', freq: 380, q: 0.8, a: 0.001, d: 0.07, g: 0.6 }, sr, r);
  // inward swell: rises after the thud and cuts off (the blow drawn in)
  noise(o, { t: 0.02, len: 0.2, type: 'bandpass', freq: (t) => 400 + 1000 * Math.min(1, t / 0.14), q: 1.2, env: (t) => envSwell(t, 0.14, 0.025, 2.5), g: 0.45 }, sr, r);
  partials(o, { t: 0.04, freqs: [220, 330, 444], amps: [0.3, 0.2, 0.12], decays: [0.35, 0.28, 0.18], a: 0.02 }, sr);
  return o;
}

function avoid(sr, r) {
  const o = makeBuf(0.22, sr);
  noise(o, { len: 0.2, type: 'bandpass', freq: (t) => 2600 - 1500 * Math.min(1, t / 0.15), q: 1, env: (t) => envSwell(t, 0.05, 0.1, 1.8), g: 1 }, sr, r);
  noise(o, { len: 0.2, type: 'bandpass', freq: 900, q: 1.5, env: (t) => envSwell(t, 0.06, 0.12, 2), am: (t) => 0.6 + 0.4 * Math.sin(TAU * 38 * t), g: 0.5 }, sr, r);
  return o;
}

function dodge(sr, r) {
  const o = makeBuf(0.34, sr);
  noise(o, { len: 0.3, type: 'bandpass', freq: sweep(450, 1500, 800, 0.1, 0.14), q: 1.1, env: (t) => envSwell(t, 0.1, 0.14, 2), g: 0.9 }, sr, r);
  noise(o, { len: 0.3, type: 'bandpass', freq: 1000, q: 1.4, env: (t) => envSwell(t, 0.1, 0.12, 2), am: (t) => 0.55 + 0.45 * Math.sin(TAU * 30 * t), g: 0.45 }, sr, r);
  noise(o, { t: 0.2, len: 0.12, type: 'lowpass', freq: 2500, q: 0.7, a: 0.001, d: 0.03, g: 0.5 }, sr, r);              // foot scuff
  noise(o, { t: 0.2, len: 0.08, type: 'highpass', freq: 5000, q: 0.7, a: 0.001, d: 0.015, g: 0.2 }, sr, r);
  return o;
}

/** Footsteps per surface: soft heel + toe on stone; crisper on tile; dull on mats; a little splash on wet stone. */
function step(surface) {
  return (sr, r) => {
    const o = makeBuf(0.14, sr);
    const k = 1 + 0.1 * r.bi();
    if (surface === 'mat') {
      noise(o, { len: 0.1, type: 'lowpass', freq: 650 * k, q: 0.8, a: 0.002, d: 0.03, g: 1 }, sr, r);
      tone(o, { f0: 75, f1: 55, glide: 0.02, a: 0.002, d: 0.04, g: 0.55 }, sr);
      noise(o, { t: 0.022, len: 0.06, type: 'lowpass', freq: 900, q: 0.7, a: 0.002, d: 0.015, g: 0.35 }, sr, r);
      return o;
    }
    const tile = surface === 'tile';
    noise(o, { len: 0.08, type: 'lowpass', freq: (tile ? 2600 : 1500) * k, q: 0.8, a: 0.0008, d: tile ? 0.014 : 0.02, g: 1 }, sr, r);
    tone(o, { f0: tile ? 125 : 88, f1: tile ? 82 : 60, glide: 0.015, a: 0.001, d: 0.025, g: 0.45 }, sr);
    noise(o, { t: 0.016 + 0.006 * r(), len: 0.05, type: 'lowpass', freq: tile ? 3000 : 2200, q: 0.7, a: 0.0006, d: 0.012, g: 0.45 }, sr, r);  // toe
    noise(o, { t: 0.004, len: 0.04, type: 'highpass', freq: 4500, q: 0.7, a: 0.0005, d: 0.01, g: tile ? 0.12 : 0.18 }, sr, r);              // grit
    if (tile) noise(o, { len: 0.03, type: 'bandpass', freq: 3200, q: 3, a: 0.0003, d: 0.006, g: 0.35 }, sr, r);
    if (surface === 'wet') {
      noise(o, { t: 0.006, len: 0.1, type: 'bandpass', freq: 2800 * k, q: 0.9, a: 0.002, d: 0.03, am: (t) => 0.6 + 0.4 * Math.sin(TAU * 140 * t), g: 0.35 }, sr, r);
      noise(o, { t: 0.01, len: 0.06, type: 'highpass', freq: 6000, q: 0.7, a: 0.001, d: 0.02, g: 0.15 }, sr, r);
    }
    return o;
  };
}

function land(sr, r) {
  const o = makeBuf(0.3, sr);
  tone(o, { f0: 110, f1: 48, glide: 0.02, a: 0.001, d: 0.08, g: 1, drive: 1.4 }, sr);
  noise(o, { len: 0.2, type: 'lowpass', freq: 1100, q: 0.7, a: 0.001, d: 0.05, g: 0.8 }, sr, r);
  noise(o, { len: 0.06, type: 'highpass', freq: 4000, q: 0.7, a: 0.0006, d: 0.015, g: 0.25 }, sr, r);
  noise(o, { t: 0.005, len: 0.12, type: 'bandpass', freq: 1300, q: 1, a: 0.001, d: 0.03, g: 0.3 }, sr, r);
  return o;
}

function knockdown(sr, r) {
  const o = makeBuf(0.6, sr);
  tone(o, { f0: 85, f1: 34, glide: 0.03, a: 0.001, d: 0.18, g: 1.2, drive: 2 }, sr);
  noise(o, { len: 0.3, type: 'lowpass', freq: 1500, q: 0.7, a: 0.001, d: 0.07, g: 0.9 }, sr, r);                       // body slap
  tone(o, { t: 0.09, f0: 90, f1: 40, glide: 0.02, a: 0.001, d: 0.06, g: 0.5 }, sr);                                  // bounce
  noise(o, { t: 0.09, len: 0.15, type: 'lowpass', freq: 1000, q: 0.7, a: 0.001, d: 0.04, g: 0.4 }, sr, r);
  noise(o, { t: 0.02, len: 0.45, type: 'bandpass', freq: 1100, q: 0.8, env: (t) => envSwell(t, 0.05, 0.3, 1.5), g: 0.35 }, sr, r); // cloth
  return softClip(o, 1.5);
}

function stance(sr, r) {
  const o = makeBuf(0.24, sr);
  noise(o, { len: 0.1, type: 'bandpass', freq: 1300 * (1 + 0.1 * r.bi()), q: 1, env: (t) => envSwell(t, 0.025, 0.05, 2), g: 0.7 }, sr, r);
  noise(o, { t: 0.07, len: 0.1, type: 'bandpass', freq: 1000, q: 1, env: (t) => envSwell(t, 0.02, 0.06, 2), g: 0.5 }, sr, r);
  noise(o, { t: 0.05, len: 0.14, type: 'lowpass', freq: (t) => 1800 - 900 * Math.min(1, t / 0.12), q: 0.8, env: (t) => envSwell(t, 0.04, 0.08, 1.5), g: 0.4 }, sr, r);
  return o;
}

function focusIn(sr, r) {
  const o = makeBuf(1.7, sr);
  // a whoosh that decelerates: falling band + a tremolo that slows (time stretching)
  noise(o, { len: 1.3, type: 'bandpass', freq: (t) => 300 + 2600 * Math.exp(-t / 0.18), q: 1.4, env: (t) => envSwell(t, 0.12, 0.95, 1.5), am: glidingTremolo(30, 3.5, 0.25, 0.4), g: 1 }, sr, r);
  noise(o, { len: 0.7, type: 'highpass', freq: 7000, q: 0.7, env: (t) => envSwell(t, 0.08, 0.45, 2), g: 0.12 }, sr, r);
  // low drone settling in
  tone(o, { f0: 110, f1: 55, glide: 0.35, a: 0.05, d: 0.6, g: 0.7, len: 1.6 }, sr);
  tone(o, { f0: 55, f1: 55, a: 0.25, d: 0.9, g: 0.6, len: 1.7 }, sr);
  tone(o, { f0: 82.4, f1: 82.4, a: 0.2, d: 0.7, g: 0.25, len: 1.6 }, sr);
  return o;
}

function focusOut(sr, r) {
  const o = makeBuf(0.45, sr);
  noise(o, { len: 0.3, type: 'bandpass', freq: (t) => 400 + 2400 * Math.pow(Math.min(1, t / 0.22), 1.5), q: 1.2, env: (t) => envSwell(t, 0.22, 0.06, 2.5), g: 1 }, sr, r);
  clicks(o, { t: 0.22, len: 0.006, count: 2, freq: 2500, q: 1.2, d: 0.002, g: 0.5 }, sr, r);
  tone(o, { t: 0.2, f0: 90, f1: 60, glide: 0.02, a: 0.001, d: 0.05, g: 0.4 }, sr);
  return o;
}

function death(sr, r) {
  const o = makeBuf(1.3, sr);
  tone(o, { f0: 70, f1: 30, glide: 0.08, a: 0.002, d: 0.35, g: 1, drive: 1.5, len: 1.2 }, sr);
  noise(o, { t: 0.05, len: 0.8, type: 'lowpass', freq: 700, q: 0.7, env: (t) => envSwell(t, 0.08, 0.5, 1.2), g: 0.35 }, sr, r); // exhale
  partials(o, { freqs: [55, 115.5, 159.5], amps: [0.5, 0.25, 0.15], decays: [0.8, 0.4, 0.25], a: 0.004, g: 0.5 }, sr);
  return o;
}

function uiMove(sr, r) {
  const o = makeBuf(0.06, sr);
  tone(o, { f0: 1350 * (1 + 0.03 * r.bi()), f1: 1300, glide: 0.01, a: 0.0005, d: 0.012, g: 0.6 }, sr);
  noise(o, { len: 0.04, type: 'bandpass', freq: 1300, q: 8, a: 0.0003, d: 0.01, g: 0.4 }, sr, r);
  noise(o, { len: 0.005, type: 'highpass', freq: 3000, q: 0.7, a: 0.0001, d: 0.001, g: 0.3 }, sr, r);
  return o;
}

function uiSelect(sr, r) {
  const o = makeBuf(0.4, sr);
  partials(o, { freqs: [1320, 1320 * 2.7], amps: [0.6, 0.2], decays: [0.06, 0.03] }, sr);
  partials(o, { t: 0.05, freqs: [1760, 1760 * 2.7], amps: [0.6, 0.2], decays: [0.08, 0.04] }, sr);
  pluck(o, { t: 0.05, freq: 880, len: 0.32, decay: 0.25, bright: 0.6, g: 0.35 }, sr, r);
  return o;
}

function uiBack(sr, r) {
  const o = makeBuf(0.12, sr);
  tone(o, { f0: 1500, f1: 900, glide: 0.03, a: 0.0005, d: 0.03, g: 0.6 }, sr);
  noise(o, { len: 0.06, type: 'bandpass', freq: 1000, q: 4, a: 0.0003, d: 0.015, g: 0.25 }, sr, r);
  return o;
}

function learned(sr, r) {
  const o = makeBuf(1.7, sr);
  const notes = [74, 77, 81, 84];       // D5 F5 A5 C6 (D minor pentatonic)
  for (let i = 0; i < notes.length; i++) pluck(o, { t: [0, 0.07, 0.14, 0.24][i], freq: mtof(notes[i]), len: 1.4, decay: 0.9, bright: 0.7, bend: 0.3, g: 0.6 - i * 0.06, body: true }, sr, r);
  partials(o, { t: 0.24, freqs: [mtof(98), mtof(98) * 2.32], amps: [0.25, 0.1], decays: [0.5, 0.2] }, sr);
  return o;
}

function heal(sr) {
  const o = makeBuf(0.55, sr);
  partials(o, { freqs: [880, 1320], amps: [0.3, 0.2], decays: [0.22, 0.15], a: 0.004 }, sr);
  partials(o, { t: 0.06, freqs: [1320, 1980], amps: [0.3, 0.2], decays: [0.25, 0.15], a: 0.004 }, sr);
  return o;
}

function feint(sr, r) {
  const o = makeBuf(0.14, sr);
  noise(o, { len: 0.12, type: 'bandpass', freq: sweep(800, 1900, 1900, 0.05, 0.05), q: 1.2, env: (t) => envSwell(t, 0.05, 0.035, 2), g: 1 }, sr, r);
  noise(o, { t: 0.05, len: 0.06, type: 'bandpass', freq: 1200, q: 1.5, a: 0.0005, d: 0.012, g: 0.5 }, sr, r);   // cloth stop
  return o;
}

/** Enemy telegraph: a soft foot scuff + cloth snap as the guard drops into the wind-up. */
function tell(sr, r) {
  const o = makeBuf(0.16, sr);
  noise(o, { len: 0.1, type: 'bandpass', freq: (t) => 800 + 700 * Math.min(1, t / 0.05), q: 0.9, env: (t) => envSwell(t, 0.03, 0.06, 2), g: 0.8 }, sr, r);   // scuff
  noise(o, { t: 0.035, len: 0.06, type: 'bandpass', freq: 1700 * (1 + 0.12 * r.bi()), q: 1.6, a: 0.0006, d: 0.016, g: 0.75 }, sr, r);              // sleeve snap
  noise(o, { t: 0.035, len: 0.01, type: 'highpass', freq: 3200, q: 0.7, a: 0.0002, d: 0.002, g: 0.3 }, sr, r);
  tone(o, { f0: 95, f1: 70, glide: 0.02, a: 0.002, d: 0.03, g: 0.3 }, sr);                                                                       // weight
  return o;
}

/** Heavy / signature telegraph (guard breakers, knockdowns): a short inhale, then the weight drops into the stance. */
function tellHeavy(sr, r) {
  const o = makeBuf(0.42, sr);
  noise(o, { len: 0.2, type: 'bandpass', freq: (t) => 1200 + 900 * Math.min(1, t / 0.16), q: 1.1, env: (t) => envSwell(t, 0.15, 0.04, 1.6), g: 0.55 }, sr, r); // inhale
  noise(o, { len: 0.2, type: 'highpass', freq: 3800, q: 0.7, env: (t) => envSwell(t, 0.15, 0.03, 2), g: 0.12 }, sr, r);
  tone(o, { t: 0.17, f0: 80, f1: 50, glide: 0.03, a: 0.002, d: 0.06, g: 0.7, drive: 1.3 }, sr);                                           // foot plant
  noise(o, { t: 0.17, len: 0.12, type: 'lowpass', freq: 900, q: 0.8, a: 0.001, d: 0.035, g: 0.6 }, sr, r);
  noise(o, { t: 0.18, len: 0.12, type: 'bandpass', freq: 1000 * (1 + 0.1 * r.bi()), q: 1.3, a: 0.001, d: 0.03, g: 0.45 }, sr, r);      // heavy cloth
  return o;
}

/** Charge hold: strained breath + cloth tension rising for up to ~1 s (stopped with a short fade on release). */
function charge(sr, r) {
  const len = 1.0, o = makeBuf(len, sr);
  const env = (t) => Math.min(1, t / 0.1) * (0.5 + 0.5 * Math.min(1, t / 0.6)) * (t > 0.9 ? Math.max(0, 1 - (t - 0.9) / 0.1) : 1);
  noise(o, { len, type: 'bandpass', freq: (t) => 500 + 1300 * Math.min(1, t / 0.7), q: 1.4, env, am: glidingTremolo(9, 24, 0.35, 0.35), g: 0.7 }, sr, r);
  noise(o, { len, type: 'lowpass', freq: 320, q: 0.7, env, g: 0.35 }, sr, r);
  noise(o, { len, type: 'highpass', freq: 4200, q: 0.7, env: (t) => env(t) * Math.min(1, t / 0.5), g: 0.08 }, sr, r);
  return o;
}

/** Charge full (the strike now breaks guard): a tiny bright tick. */
function chargeFull(sr, r) {
  const o = makeBuf(0.12, sr);
  partials(o, { freqs: [2350, 2350 * 2.32], amps: [0.5, 0.2], decays: [0.03, 0.015], a: 0.0005 }, sr);
  noise(o, { len: 0.006, type: 'highpass', freq: 3500, q: 0.7, a: 0.0001, d: 0.0015, g: 0.6 }, sr, r);
  return o;
}

function gate(sr, r) {
  const o = makeBuf(1.15, sr);
  noise(o, { len: 0.8, type: 'lowpass', freq: 180, q: 0.7, env: (t) => Math.min(1, t / 0.1) * (t < 0.7 ? 1 : Math.exp(-(t - 0.7) / 0.05)), g: 0.9 }, sr, r);
  clicks(o, { len: 0.65, count: 14, freq: 1800, q: 1.4, d: 0.006, g: 0.35 }, sr, r);
  noise(o, { len: 0.72, type: 'bandpass', freq: 600, q: 3, env: (t) => Math.min(1, t / 0.08) * (t < 0.68 ? 1 : 0), am: (t) => 0.5 + 0.5 * Math.sin(TAU * 22 * t), g: 0.25 }, sr, r);
  tone(o, { t: 0.7, f0: 95, f1: 45, glide: 0.02, a: 0.001, d: 0.12, g: 1, drive: 2 }, sr);
  noise(o, { t: 0.7, len: 0.2, type: 'lowpass', freq: 1200, q: 0.7, a: 0.001, d: 0.05, g: 0.7 }, sr, r);
  partials(o, { t: 0.7, freqs: [430, 1130], amps: [0.25, 0.12], decays: [0.25, 0.12] }, sr);
  return o;
}

/** Big taiko-like drum hit (also used by the music). */
export function taiko(o, t, f, g, sr, r) {
  tone(o, { t, f0: f * 1.45, f1: f, glide: 0.025, a: 0.001, d: 0.42, g: 1.1 * g, drive: 1.6, len: 1.4 }, sr);
  tone(o, { t, f0: f * 2.3, f1: f * 1.59, glide: 0.02, a: 0.001, d: 0.14, g: 0.3 * g }, sr);
  noise(o, { t, len: 0.12, type: 'lowpass', freq: 1500, q: 0.7, a: 0.0005, d: 0.025, g: 0.5 * g }, sr, r);
  noise(o, { t, len: 0.6, type: 'lowpass', freq: 160, q: 0.8, a: 0.002, d: 0.2, g: 0.6 * g }, sr, r);
  return o;
}

function bossSting(sr, r) {
  const o = makeBuf(3.2, sr);
  taiko(o, 0, 52, 1, sr, r);
  taiko(o, 0.32, 48, 0.7, sr, r);
  // dissonant plucked cluster (minor second) + bowed tension
  pluck(o, { t: 0.02, freq: mtof(50), len: 2.8, decay: 2.5, bright: 0.45, bend: 0.4, g: 0.5, body: true }, sr, r);
  pluck(o, { t: 0.05, freq: mtof(51), len: 2.8, decay: 2.3, bright: 0.4, bend: 0.3, g: 0.4, body: true }, sr, r);
  pluck(o, { t: 0.08, freq: mtof(57), len: 2.8, decay: 2.0, bright: 0.4, g: 0.35, body: true }, sr, r);
  tone(o, { f0: mtof(50), wave: 'tri', vib: 0.004, vibRate: 5, env: (t) => envSwell(t, 0.6, 2.2, 1.2), g: 0.22, len: 3 }, sr);
  tone(o, { f0: mtof(51), wave: 'tri', vib: 0.005, vibRate: 4.3, env: (t) => envSwell(t, 0.7, 2.1, 1.2), g: 0.18, len: 3 }, sr);
  partials(o, { freqs: [65, 65 * 1.48, 65 * 2.1, 65 * 2.7], amps: [0.6, 0.35, 0.25, 0.15], decays: [2.2, 1.4, 0.9, 0.6], beat: 0.7, a: 0.01 }, sr);
  return softClip(o, 1.2);
}

function ageUp(sr, r) {
  // a single deep temple bell: hum, prime, tierce, quint, nominal... with slow beating
  const o = makeBuf(6.5, sr);
  const f = 98;
  partials(o, {
    freqs: [0.5, 1.0, 1.183, 1.506, 2.0, 2.66, 3.01, 4.16].map((k) => f * k),
    amps: [0.55, 0.9, 0.35, 0.3, 0.45, 0.25, 0.2, 0.12],
    decays: [2.6, 2.0, 1.4, 1.2, 1.0, 0.6, 0.45, 0.3],
    beat: 0.9, a: 0.003, len: 6.4,
  }, sr);
  noise(o, { len: 0.1, type: 'lowpass', freq: 1200, q: 0.7, a: 0.0005, d: 0.02, g: 0.5 }, sr, r);   // wooden striker
  tone(o, { f0: 220, f1: 110, glide: 0.005, a: 0.0005, d: 0.04, g: 0.3 }, sr);
  return o;
}

function victory(sr, r) {
  const o = makeBuf(3.0, sr);
  taiko(o, 0, 58, 0.9, sr, r);
  taiko(o, 0.18, 58, 0.7, sr, r);
  const notes = [62, 65, 67, 69, 72, 74];   // D F G A C D: resolving to the tonic
  for (let i = 0; i < notes.length; i++) {
    pluck(o, { t: 0.36 + i * 0.14, freq: mtof(notes[i]), len: 2.2, decay: i === notes.length - 1 ? 1.8 : 0.9, bright: 0.65, bend: 0.25, g: 0.55, body: true }, sr, r);
  }
  partials(o, { t: 0.36 + 5 * 0.14, freqs: [mtof(86), mtof(86) * 2.32], amps: [0.25, 0.1], decays: [1.2, 0.5] }, sr);
  return o;
}

// ------------------------------------------------------------------------------------------------ table

/** Every sound the game can play by name (FIGHTER.md §10), plus a few extras (feint, heal, step_<surface>). */
export const SFX = {
  whoosh_light: { gen: whooshLight, variants: 4, vol: 0.42, rev: 0.05, combat: true },
  whoosh_heavy: { gen: whooshHeavy, variants: 3, vol: 0.52, rev: 0.06, combat: true },
  hit_light: { gen: hitLight, variants: 4, vol: 0.8, rev: 0.1, combat: true },
  hit_body: { gen: hitBody, variants: 4, vol: 0.85, rev: 0.1, combat: true },
  hit_face: { gen: hitFace, variants: 4, vol: 0.72, rev: 0.1, combat: true },
  hit_heavy: { gen: hitHeavy, variants: 3, vol: 1.0, rev: 0.14, combat: true },
  block: { gen: block, variants: 4, vol: 0.7, rev: 0.08, combat: true },
  guard_break: { gen: guardBreak, variants: 2, vol: 0.9, rev: 0.15, combat: true },
  parry: { gen: parry, variants: 3, vol: 0.72, rev: 0.22, combat: true },
  absorb: { gen: absorb, variants: 2, vol: 0.75, rev: 0.12, combat: true },
  avoid: { gen: avoid, variants: 3, vol: 0.45, rev: 0.05, combat: true },
  dodge: { gen: dodge, variants: 3, vol: 0.5, rev: 0.05, combat: true },
  step_stone: { gen: step('stone'), variants: 5, vol: 0.26, rev: 0.06, prio: 0, combat: true, throttle: 0.05 },
  step_tile: { gen: step('tile'), variants: 5, vol: 0.24, rev: 0.07, prio: 0, combat: true, throttle: 0.05 },
  step_mat: { gen: step('mat'), variants: 5, vol: 0.3, rev: 0.04, prio: 0, combat: true, throttle: 0.05 },
  step_wet: { gen: step('wet'), variants: 5, vol: 0.26, rev: 0.05, prio: 0, combat: true, throttle: 0.05 },
  land: { gen: land, variants: 2, vol: 0.55, rev: 0.08, combat: true },
  knockdown: { gen: knockdown, variants: 2, vol: 0.85, rev: 0.12, combat: true },
  stance: { gen: stance, variants: 3, vol: 0.35, rev: 0.04, combat: true },
  focus_in: { gen: focusIn, variants: 1, vol: 0.7, rev: 0.2 },
  focus_out: { gen: focusOut, variants: 1, vol: 0.5, rev: 0.12 },
  death: { gen: death, variants: 2, vol: 0.8, rev: 0.25, combat: true },
  ui_move: { gen: uiMove, variants: 2, vol: 0.3, rev: 0, ui: true, throttle: 0.02 },
  ui_select: { gen: uiSelect, variants: 1, vol: 0.4, rev: 0.05, ui: true },
  ui_back: { gen: uiBack, variants: 1, vol: 0.35, rev: 0, ui: true },
  learned: { gen: learned, variants: 1, vol: 0.55, rev: 0.3, ui: true },
  gate: { gen: gate, variants: 1, vol: 0.6, rev: 0.15 },
  boss_sting: { gen: bossSting, variants: 1, vol: 0.85, rev: 0.3, ui: true },
  age_up: { gen: ageUp, variants: 1, vol: 0.8, rev: 0.35, ui: true },
  victory: { gen: victory, variants: 1, vol: 0.75, rev: 0.3, ui: true },
  feint: { gen: feint, variants: 2, vol: 0.35, rev: 0.03, combat: true },
  heal: { gen: heal, variants: 1, vol: 0.4, rev: 0.2 },
  tell: { gen: tell, variants: 3, vol: 0.7, rev: 0.05, prio: 0, combat: true, throttle: 0.05 },
  tell_heavy: { gen: tellHeavy, variants: 2, vol: 0.7, rev: 0.08, combat: true },
  charge: { gen: charge, variants: 2, vol: 0.5, rev: 0.06, combat: true },
  charge_full: { gen: chargeFull, variants: 1, vol: 0.45, rev: 0.06, combat: true },
};

/** Contract names (FIGHTER.md §10). 'step' resolves to the current surface's step_<surface>. */
export const CONTRACT_SOUNDS = ['whoosh_light', 'whoosh_heavy', 'hit_light', 'hit_heavy', 'hit_body', 'hit_face', 'block',
  'guard_break', 'parry', 'absorb', 'avoid', 'dodge', 'step', 'land', 'knockdown', 'stance', 'focus_in', 'focus_out',
  'death', 'ui_move', 'ui_select', 'ui_back', 'learned', 'gate', 'boss_sting', 'age_up', 'victory'];

/** Peak time of the whoosh recipes (s at rate 1): the whoosh is started so its peak lands on the strike. */
export const WHOOSH_PEAK = { whoosh_light: 0.085, whoosh_heavy: 0.16 };

function hashName(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Render one variant of a sound (deterministic). Returns a mono Float32Array at `sr`. */
export function renderSfx(name, variant = 0, sr = SR) {
  const def = SFX[name];
  if (!def) return null;
  const r = rng(hashName(name) + variant * 7919 + 1);
  let o = def.gen(sr, r, variant);
  highpassDC(o, 22, sr);
  normalize(o, 0.89);
  o = trim(o, 0.0006, sr);
  return o;
}
