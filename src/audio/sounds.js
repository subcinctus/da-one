// Sound recipes (owned by ATMOSPHERE). Every §4.4 sound name is synthesised here from oscillators + filtered noise.
// A recipe is fn(kit, out, t, o) -> duration (s). o = { pitch (multiplier), intensity (0..1+), duration? }.
// Meta per recipe: bus ('sfx' | 'ui'), range (m, silent beyond), prio (voice stealing), max (concurrent copies),
// gain (mix level), verb (world reverb send 0..1), jitter (random pitch spread).

const R = (a, b) => a + Math.random() * (b - a);

// ------------------------------------------------------------------------------------------------ weapons
function gunCore(k, out, t, p, c) {
  // crack: band-passed noise burst
  k.burst(t, { filter: 'bandpass', freq: c.crack * p, freq1: c.crack * 0.55 * p, q: c.q ?? 0.9, dur: c.crackDur, gain: 1.0 }, out);
  // bright snap
  k.burst(t, { filter: 'highpass', freq: 4200, q: 0.7, dur: 0.018, gain: 0.55 }, out);
  // low thump (body)
  k.tone(t, { type: 'sine', f0: c.thump * p, f1: c.thump * 0.32 * p, dur: c.thumpDur, gain: c.thumpGain ?? 0.9 }, out);
  // distorted punch for weight
  const sh = k.shaper(3.5, out);
  const g = k.gain(0, sh);
  k.osc('triangle', c.thump * 1.5 * p, t, c.thumpDur, g);
  k.perc(g.gain, t, 0.35, c.thumpDur * 0.6);
  // outdoor slap-back tail
  k.burst(t + 0.035, { filter: 'lowpass', freq: c.tailFreq ?? 1400, q: 0.5, dur: c.tail, gain: c.tailGain ?? 0.22, attack: 0.02, kind: 'pink' }, out);
  return Math.max(c.crackDur, c.thumpDur, c.tail + 0.06);
}

const gunshot_pistol = (k, out, t, o) => gunCore(k, out, t, o.pitch, { crack: 2100, crackDur: 0.11, thump: 170, thumpDur: 0.09, tail: 0.32 });
const gunshot_smg = (k, out, t, o) => gunCore(k, out, t, o.pitch, { crack: 2700, crackDur: 0.065, thump: 210, thumpDur: 0.055, thumpGain: 0.7, tail: 0.18, tailGain: 0.14, q: 1.1 });
const gunshot_rifle = (k, out, t, o) => gunCore(k, out, t, o.pitch, { crack: 1600, crackDur: 0.12, thump: 135, thumpDur: 0.1, thumpGain: 1, tail: 0.42, tailGain: 0.24 });
function gunshot_shotgun(k, out, t, o) {
  const p = o.pitch;
  const d = gunCore(k, out, t, p, { crack: 950, crackDur: 0.3, thump: 105, thumpDur: 0.22, thumpGain: 1.1, tail: 0.6, tailGain: 0.3, tailFreq: 1000, q: 0.6 });
  k.burst(t, { filter: 'lowpass', freq: 3200, q: 0.5, dur: 0.16, gain: 0.7 }, out);
  // pump action
  pumpClick(k, out, t + 0.42, 0.45);
  pumpClick(k, out, t + 0.56, 0.5);
  return Math.max(d, 0.7);
}
function pumpClick(k, out, t, gain) {
  k.burst(t, { filter: 'bandpass', freq: 2600, q: 2, dur: 0.035, gain }, out);
  k.tone(t, { type: 'square', f0: 620, f1: 420, dur: 0.03, gain: gain * 0.25 }, out);
}
function gunshot_sniper(k, out, t, o) {
  const p = o.pitch;
  gunCore(k, out, t, p, { crack: 1250, crackDur: 0.26, thump: 92, thumpDur: 0.32, thumpGain: 1.2, tail: 0.9, tailGain: 0.3, tailFreq: 900, q: 0.6 });
  k.burst(t, { filter: 'highpass', freq: 2600, q: 0.6, dur: 0.06, gain: 0.8 }, out);
  // distant echo off buildings
  k.burst(t + 0.28, { filter: 'lowpass', freq: 700, q: 0.4, dur: 0.7, gain: 0.16, attack: 0.04, kind: 'pink' }, out);
  k.burst(t + 0.55, { filter: 'lowpass', freq: 520, q: 0.4, dur: 0.6, gain: 0.08, attack: 0.05, kind: 'pink' }, out);
  return 1.3;
}
function rocket_launch(k, out, t, o) {
  const p = o.pitch;
  k.tone(t, { type: 'sine', f0: 90 * p, f1: 38 * p, dur: 0.25, gain: 1 }, out);
  k.burst(t, { filter: 'bandpass', freq: 380 * p, freq1: 2600 * p, sweep: 0.55, q: 1.2, dur: 0.95, gain: 0.85, attack: 0.04 }, out);
  k.burst(t, { filter: 'highpass', freq: 3000, q: 0.5, dur: 0.6, gain: 0.25, attack: 0.03 }, out);
  k.burst(t, { filter: 'lowpass', freq: 900, q: 0.5, dur: 0.4, gain: 0.5, kind: 'brown' }, out);
  return 1.0;
}
function explosion(k, out, t, o) {
  const p = o.pitch, I = Math.min(1.6, o.intensity ?? 1);
  const len = 2.0 + I * 0.6;
  // main body: low-passed noise whose cutoff closes, through a little drive
  const sh = k.shaper(2.2, out);
  const g = k.gain(0, sh);
  const f = k.filter('lowpass', 2400 * p, 0.8, g);
  k.sweep(f.frequency, t, 2600 * p, 160 * p, len * 0.75);
  k.noise(t, len, f, 'brown');
  k.noise(t, len * 0.5, f, 'white', 0.8);
  k.perc(g.gain, t, 1.1 * I, len, 0.006);
  // sub-bass boom
  k.tone(t, { type: 'sine', f0: 72 * p, f1: 26 * p, dur: 1.1, sweep: 0.8, gain: 1.4 * I }, out);
  k.tone(t, { type: 'triangle', f0: 120 * p, f1: 40 * p, dur: 0.35, gain: 0.5 * I }, out);
  // initial crack
  k.burst(t, { filter: 'highpass', freq: 1800, q: 0.5, dur: 0.08, gain: 0.9 }, out);
  // debris crackle
  for (let i = 0; i < 9; i++) {
    const dt = R(0.12, 1.1);
    k.burst(t + dt, { filter: 'bandpass', freq: R(1500, 4200), q: 1.5, dur: R(0.02, 0.06), gain: R(0.08, 0.22) * I }, out);
  }
  return len;
}
function grenade_bounce(k, out, t, o) {
  const p = o.pitch;
  k.tone(t, { type: 'triangle', f0: 1850 * p, dur: 0.09, gain: 0.5 }, out);
  k.tone(t, { type: 'square', f0: 2760 * p, dur: 0.05, gain: 0.12 }, out);
  k.tone(t, { type: 'sine', f0: 4100 * p, dur: 0.06, gain: 0.2 }, out);
  k.burst(t, { filter: 'lowpass', freq: 700, q: 0.7, dur: 0.05, gain: 0.5 }, out);
  return 0.12;
}
function punch(k, out, t, o) {
  const p = o.pitch;
  k.tone(t, { type: 'sine', f0: 140 * p, f1: 55 * p, dur: 0.11, gain: 1.1 }, out);
  k.burst(t, { filter: 'lowpass', freq: 1100 * p, q: 0.8, dur: 0.07, gain: 0.8 }, out);
  k.burst(t, { filter: 'highpass', freq: 2500, q: 0.6, dur: 0.025, gain: 0.4 }, out);
  return 0.14;
}
function melee_swing(k, out, t, o) {
  const p = o.pitch;
  const g = k.gain(0, out);
  const f = k.filter('bandpass', 500 * p, 2.2, g);
  f.frequency.setValueAtTime(500 * p, t);
  f.frequency.exponentialRampToValueAtTime(1900 * p, t + 0.1);
  f.frequency.exponentialRampToValueAtTime(700 * p, t + 0.24);
  k.noise(t, 0.26, f, 'white');
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.9, t + 0.09);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  return 0.27;
}
function reload(k, out, t, o) {
  const p = o.pitch;
  // mag out
  k.burst(t, { filter: 'highpass', freq: 3000, q: 1, dur: 0.015, gain: 0.6 }, out);
  k.tone(t, { type: 'square', f0: 900 * p, f1: 600 * p, dur: 0.03, gain: 0.12 }, out);
  // slide
  k.burst(t + 0.16, { filter: 'bandpass', freq: 1300 * p, freq1: 2200 * p, q: 2, dur: 0.13, gain: 0.35, attack: 0.03 }, out);
  // mag in clack
  k.burst(t + 0.42, { filter: 'bandpass', freq: 1800 * p, q: 1.6, dur: 0.05, gain: 0.8 }, out);
  k.tone(t + 0.42, { type: 'square', f0: 760 * p, f1: 380 * p, dur: 0.05, gain: 0.2 }, out);
  // charge handle
  k.burst(t + 0.62, { filter: 'highpass', freq: 2400, q: 1.2, dur: 0.03, gain: 0.6 }, out);
  k.burst(t + 0.7, { filter: 'bandpass', freq: 2100 * p, q: 2.5, dur: 0.04, gain: 0.7 }, out);
  return 0.8;
}
function empty_click(k, out, t, o) {
  k.tone(t, { type: 'square', f0: 2300 * o.pitch, f1: 1500 * o.pitch, dur: 0.012, gain: 0.25 }, out);
  k.burst(t, { filter: 'highpass', freq: 4000, q: 1, dur: 0.02, gain: 0.5 }, out);
  return 0.05;
}
function bullet_impact(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'bandpass', freq: 2600 * p, q: 1.2, dur: 0.045, gain: 0.8 }, out);
  k.tone(t, { type: 'sine', f0: 320 * p, f1: 120 * p, dur: 0.04, gain: 0.5 }, out);
  let d = 0.08;
  if (Math.random() < 0.28) {
    // ricochet "pew-ow"
    k.tone(t + 0.01, { type: 'sine', f0: R(2400, 3200) * p, f1: R(700, 1000) * p, dur: 0.28, sweep: 0.26, gain: 0.18 }, out);
    d = 0.32;
  }
  return d;
}
function glass_break(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'highpass', freq: 3800, q: 0.7, dur: 0.32, gain: 0.7 }, out);
  k.burst(t, { filter: 'bandpass', freq: 2200, q: 1, dur: 0.08, gain: 0.6 }, out);
  for (let i = 0; i < 11; i++) {
    const dt = R(0, 0.45) * R(0.3, 1);
    k.tone(t + dt, { type: Math.random() < 0.5 ? 'sine' : 'triangle', f0: R(2800, 7200) * p, dur: R(0.04, 0.12), gain: R(0.08, 0.22) }, out);
  }
  return 0.6;
}

// ------------------------------------------------------------------------------------------------ blocks / movement
function block_break(k, out, t, o) {
  const p = o.pitch;
  for (let i = 0; i < 4; i++) {
    k.burst(t + i * R(0.018, 0.032), { filter: 'bandpass', freq: R(500, 900) * p, q: 1.3, dur: R(0.03, 0.06), gain: R(0.5, 0.9) }, out);
  }
  k.tone(t, { type: 'sine', f0: 170 * p, f1: 80 * p, dur: 0.08, gain: 0.5 }, out);
  k.burst(t + 0.02, { filter: 'lowpass', freq: 1800 * p, q: 0.5, dur: 0.14, gain: 0.35, kind: 'pink' }, out);
  return 0.2;
}
function block_place(k, out, t, o) {
  const p = o.pitch;
  k.tone(t, { type: 'sine', f0: 240 * p, f1: 140 * p, dur: 0.07, gain: 0.9 }, out);
  k.burst(t, { filter: 'lowpass', freq: 1300 * p, q: 0.8, dur: 0.045, gain: 0.6 }, out);
  k.burst(t, { filter: 'bandpass', freq: 2400 * p, q: 2, dur: 0.012, gain: 0.25 }, out);
  return 0.1;
}
function block_hit(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'bandpass', freq: 1100 * p, q: 1.4, dur: 0.04, gain: 0.7 }, out);
  k.tone(t, { type: 'sine', f0: 260 * p, f1: 160 * p, dur: 0.03, gain: 0.3 }, out);
  return 0.06;
}
/** Surface flavour for steps / landings: filter colour + an extra layer. */
const SURFACE = {
  grass: { lp: 650, q: 0.7, mid: 1100, midGain: 0.25, extra: 'rustle' },
  dirt: { lp: 600, q: 0.8, mid: 900, midGain: 0.3, extra: null },
  sand: { lp: 1600, q: 0.6, mid: 2600, midGain: 0.35, extra: 'crunch' },
  snow: { lp: 1300, q: 0.6, mid: 2100, midGain: 0.3, extra: 'crunch' },
  stone: { lp: 1500, q: 1.1, mid: 2200, midGain: 0.45, extra: 'click' },
  wood: { lp: 900, q: 1.6, mid: 1500, midGain: 0.4, extra: 'hollow' },
  metal: { lp: 2200, q: 2.5, mid: 3200, midGain: 0.4, extra: 'clang' },
  glass: { lp: 2600, q: 1.5, mid: 3800, midGain: 0.35, extra: 'click' },
  water: { lp: 1800, q: 0.6, mid: 900, midGain: 0.4, extra: 'slosh' },
};
function surfaceLayer(k, out, t, p, sf, gain) {
  switch (sf.extra) {
    case 'rustle': k.burst(t + 0.01, { filter: 'highpass', freq: 3500, q: 0.5, dur: 0.06, gain: 0.18 * gain }, out); break;
    case 'crunch': for (let i = 0; i < 3; i++) k.burst(t + i * 0.012, { filter: 'bandpass', freq: R(2500, 4500), q: 2, dur: 0.012, gain: 0.25 * gain }, out); break;
    case 'click': k.burst(t, { filter: 'highpass', freq: 3000, q: 1, dur: 0.012, gain: 0.35 * gain }, out); break;
    case 'hollow': k.tone(t, { type: 'triangle', f0: 260 * p, f1: 180 * p, dur: 0.06, gain: 0.3 * gain }, out); break;
    case 'clang': k.tone(t, { type: 'triangle', f0: R(900, 1300) * p, dur: 0.09, gain: 0.12 * gain }, out); break;
    case 'slosh': k.burst(t, { filter: 'lowpass', freq: 2500, freq1: 600, q: 0.6, dur: 0.18, gain: 0.5 * gain }, out); break;
    default: break;
  }
}
function footstep(k, out, t, o) {
  const p = o.pitch;
  const sf = SURFACE[o.surface] || SURFACE.stone;
  k.burst(t, { filter: 'lowpass', freq: sf.lp * R(0.85, 1.15) * p, q: sf.q, dur: 0.05, gain: 0.8 }, out);
  k.burst(t + R(0.035, 0.05), { filter: 'bandpass', freq: sf.mid * R(0.85, 1.15) * p, q: 1.1, dur: 0.035, gain: sf.midGain }, out);
  k.tone(t, { type: 'sine', f0: 110 * p, f1: 70 * p, dur: 0.04, gain: 0.35 }, out);
  surfaceLayer(k, out, t, p, sf, 1);
  return o.surface === 'water' ? 0.22 : 0.1;
}
function jump(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'bandpass', freq: 800 * p, freq1: 1500 * p, q: 1.2, dur: 0.12, gain: 0.45, attack: 0.02 }, out);
  k.burst(t, { filter: 'lowpass', freq: 600, q: 0.7, dur: 0.05, gain: 0.4 }, out);
  return 0.15;
}
function land(k, out, t, o) {
  const p = o.pitch, I = Math.min(1.5, o.intensity ?? 1);
  const sf = SURFACE[o.surface] || SURFACE.dirt;
  k.tone(t, { type: 'sine', f0: 95 * p, f1: 45 * p, dur: 0.12, gain: 1.0 * I }, out);
  k.burst(t, { filter: 'lowpass', freq: Math.min(1400, sf.lp) * p, q: 0.8, dur: 0.09, gain: 0.7 * I }, out);
  surfaceLayer(k, out, t, p, sf, I);
  return 0.2;
}
function splash(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'lowpass', freq: 4200 * p, freq1: 500 * p, sweep: 0.5, q: 0.6, dur: 0.6, gain: 0.9, attack: 0.008 }, out);
  k.burst(t, { filter: 'highpass', freq: 2000, q: 0.5, dur: 0.25, gain: 0.35 }, out);
  for (let i = 0; i < 6; i++) {
    const f = R(380, 900) * p;
    k.tone(t + R(0.08, 0.55), { type: 'sine', f0: f, f1: f * 1.8, dur: 0.05, gain: R(0.06, 0.15) }, out);
  }
  return 0.7;
}

// ------------------------------------------------------------------------------------------------ vehicles
function car_door(k, out, t, o) {
  const p = o.pitch;
  k.burst(t, { filter: 'highpass', freq: 2500, q: 1, dur: 0.012, gain: 0.4 }, out); // latch
  k.tone(t + 0.03, { type: 'sine', f0: 95 * p, f1: 52 * p, dur: 0.14, gain: 1.1 }, out);
  k.burst(t + 0.03, { filter: 'lowpass', freq: 750 * p, q: 0.9, dur: 0.12, gain: 0.8 }, out);
  k.burst(t + 0.03, { filter: 'bandpass', freq: 1700 * p, q: 3, dur: 0.06, gain: 0.25 }, out); // rattle
  return 0.22;
}
function horn(k, out, t, o) {
  const p = o.pitch;
  const dur = Math.max(0.12, Math.min(3, o.duration ?? 0.45));
  const g = k.gain(0, out);
  const f = k.filter('lowpass', 2300, 1.2, g);
  k.osc('square', 404 * p, t, dur + 0.06, f, -6);
  k.osc('square', 509 * p, t, dur + 0.06, f, 5);
  k.osc('sawtooth', 404 * p, t, dur + 0.06, f, 9);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.42, t + 0.012);
  g.gain.setValueAtTime(0.42, t + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
  return dur + 0.06;
}
function crash(k, out, t, o) {
  const p = o.pitch, I = Math.min(1.5, o.intensity ?? 1);
  k.burst(t, { filter: 'bandpass', freq: 1200 * p, q: 0.6, dur: 0.5, gain: 0.9 * I }, out);
  k.tone(t, { type: 'sine', f0: 70 * p, f1: 35 * p, dur: 0.25, gain: 1.0 * I }, out);
  const partials = [523, 739, 1187, 1663, 2211];
  for (const f of partials) {
    k.tone(t + R(0, 0.02), { type: Math.random() < 0.5 ? 'square' : 'triangle', f0: f * p * R(0.96, 1.04), dur: R(0.15, 0.45), gain: R(0.04, 0.09) * I }, out);
  }
  for (let i = 0; i < 5; i++) {
    k.burst(t + R(0.05, 0.35), { filter: 'bandpass', freq: R(2000, 5000), q: 2, dur: R(0.02, 0.05), gain: R(0.1, 0.25) * I }, out);
  }
  return 0.6;
}
function tire_screech(k, out, t, o) {
  const p = o.pitch;
  const dur = Math.max(0.2, Math.min(2.5, o.duration ?? 0.7));
  const g = k.gain(0, out);
  const f = k.filter('bandpass', 1050 * p, 6, g);
  const s = k.osc('sawtooth', 1020 * p, t, dur, f);
  k.osc('sine', 13, t, dur, k.gain(30, s.frequency));
  k.burst(t, { filter: 'bandpass', freq: 2600 * p, q: 3, dur, gain: 0.35, attack: 0.04 }, out);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.05);
  g.gain.setValueAtTime(0.4, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return dur;
}
function car_alarm(k, out, t, o) {
  const p = o.pitch;
  const dur = Math.max(0.5, Math.min(6, o.duration ?? 2.2));
  const g = k.gain(0, out);
  const f = k.filter('bandpass', 1500, 1.4, g);
  const s = k.osc('square', 1300 * p, t, dur, f);
  for (let i = 0; i * 0.22 < dur; i++) s.frequency.setValueAtTime((i % 2 ? 900 : 1300) * p, t + i * 0.22);
  k.env(g.gain, t, 0.3, 0.01, dur - 0.06, 0.05);
  return dur;
}

// ------------------------------------------------------------------------------------------------ player / pickups / UI
function arp(k, out, t, notes, step, type = 'square', gain = 0.3, len = 0.09) {
  notes.forEach((f, i) => k.note(t + i * step, { type, freq: f, a: 0.004, hold: len * 0.5, r: len, gain }, out));
  return notes.length * step + len * 1.5;
}
function pickup(k, out, t, o) {
  const p = o.pitch;
  return arp(k, out, t, [1047, 1319, 1568, 2093].map((f) => f * p), 0.055, 'square', 0.16, 0.08);
}
function money(k, out, t, o) {
  const p = o.pitch;
  // "ka": register key + drawer
  k.burst(t, { filter: 'bandpass', freq: 3000, q: 2, dur: 0.02, gain: 0.5 }, out);
  k.burst(t + 0.03, { filter: 'bandpass', freq: 900, q: 1.5, dur: 0.06, gain: 0.35 }, out);
  // "ching": inharmonic bell
  const t2 = t + 0.085;
  const partials = [[2093, 0.3], [2637, 0.22], [3136, 0.18], [4186, 0.12], [5274, 0.08], [2793 * 1.41, 0.05]];
  for (const [f, g] of partials) k.note(t2, { type: 'sine', freq: f * p, a: 0.002, hold: 0.02, r: 0.7, gain: g }, out);
  // coin sparkle
  for (let i = 0; i < 4; i++) k.note(t2 + 0.05 + i * 0.05, { type: 'triangle', freq: R(4500, 6500) * p, a: 0.002, hold: 0.01, r: 0.08, gain: 0.06 }, out);
  return 0.9;
}
function hurt(k, out, t, o) {
  const p = o.pitch * R(0.92, 1.08);
  const g = k.gain(0, out);
  const f = k.filter('bandpass', 750 * p, 3, g);
  const s = k.osc('sawtooth', 190 * p, t, 0.2, f);
  s.frequency.setValueAtTime(205 * p, t);
  s.frequency.exponentialRampToValueAtTime(125 * p, t + 0.18);
  const f2 = k.filter('bandpass', 1300 * p, 4, g);
  s.connect(f2);
  k.perc(g.gain, t, 0.9, 0.18, 0.012);
  k.burst(t, { filter: 'lowpass', freq: 400, q: 0.7, dur: 0.07, gain: 0.5 }, out);
  return 0.22;
}
function death(k, out, t, o) {
  const p = o.pitch;
  const g = k.gain(0, out);
  const f = k.filter('lowpass', 1600, 2, g);
  k.sweep(f.frequency, t, 1600, 300, 0.9);
  const s = k.osc('sawtooth', 230 * p, t, 1.0, f);
  k.sweep(s.frequency, t, 230 * p, 55 * p, 0.95);
  const s2 = k.osc('square', 115 * p, t, 1.0, f, 7);
  k.sweep(s2.frequency, t, 115 * p, 30 * p, 0.95);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
  k.tone(t + 0.75, { type: 'sine', f0: 80, f1: 40, dur: 0.18, gain: 0.8 }, out);
  k.burst(t + 0.75, { filter: 'lowpass', freq: 500, q: 0.7, dur: 0.12, gain: 0.6 }, out);
  return 1.05;
}
function ui_click(k, out, t, o) {
  k.note(t, { type: 'sine', freq: 1500 * o.pitch, a: 0.001, hold: 0.005, r: 0.03, gain: 0.35 }, out);
  k.burst(t, { filter: 'highpass', freq: 5000, q: 0.7, dur: 0.008, gain: 0.25 }, out);
  return 0.05;
}
function ui_open(k, out, t, o) {
  const p = o.pitch;
  k.note(t, { type: 'triangle', freq: 660 * p, a: 0.003, hold: 0.03, r: 0.07, gain: 0.35 }, out);
  k.note(t + 0.06, { type: 'triangle', freq: 990 * p, a: 0.003, hold: 0.03, r: 0.12, gain: 0.35 }, out);
  return 0.22;
}
/** Brassy chord stab (detuned saws through a low-pass with a filter envelope). */
function brass(k, out, t, freqs, dur, gain = 0.18, bright = 2400) {
  const g = k.gain(0, out);
  const f = k.filter('lowpass', 400, 1.5, g);
  f.frequency.setValueAtTime(400, t);
  f.frequency.exponentialRampToValueAtTime(bright, t + 0.06);
  f.frequency.exponentialRampToValueAtTime(bright * 0.45, t + dur);
  for (const fr of freqs) {
    k.osc('sawtooth', fr, t, dur + 0.1, f, -7);
    k.osc('sawtooth', fr, t, dur + 0.1, f, 7);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.025);
  g.gain.setValueAtTime(gain * 0.8, t + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
}
const N = (m) => 440 * Math.pow(2, (m - 69) / 12);
function mission_start(k, out, t, o) {
  const p = o.pitch;
  // rising riser + minor stab
  k.burst(t, { filter: 'bandpass', freq: 300, freq1: 3000, sweep: 0.6, q: 2, dur: 0.65, gain: 0.25, attack: 0.5 }, out);
  brass(k, out, t + 0.62, [N(57), N(60), N(64)].map((f) => f * p), 0.5, 0.16);
  k.tone(t + 0.62, { type: 'sine', f0: 110 * p, f1: 55 * p, dur: 0.4, gain: 0.7 }, out);
  k.burst(t + 0.62, { filter: 'highpass', freq: 5000, dur: 0.6, q: 0.5, gain: 0.15 }, out);
  return 1.3;
}
function mission_passed(k, out, t, o) {
  const p = o.pitch;
  // I - IV - V - I with a bright lead and a final sparkle
  const prog = [[60, 64, 67], [60, 65, 69], [62, 67, 71], [64, 67, 72]];
  const times = [0, 0.3, 0.6, 0.9];
  prog.forEach((ch, i) => {
    const dur = i === 3 ? 1.5 : 0.26;
    brass(k, out, t + times[i], ch.map((m) => N(m) * p), dur, i === 3 ? 0.17 : 0.14, i === 3 ? 3200 : 2600);
    k.tone(t + times[i], { type: 'sine', f0: N(ch[0] - 24) * p, dur: i === 3 ? 1.2 : 0.25, gain: 0.55 }, out);
    k.burst(t + times[i], { filter: 'highpass', freq: 6000, q: 0.5, dur: 0.06, gain: 0.18 }, out);
  });
  // lead melody on top
  const lead = [[72, 0], [76, 0.3], [79, 0.6], [84, 0.9]];
  for (const [m, dt] of lead) k.note(t + dt, { type: 'square', freq: N(m) * p, a: 0.01, hold: dt === 0.9 ? 0.9 : 0.18, r: 0.25, gain: 0.08 }, out);
  // sparkle arpeggio
  for (let i = 0; i < 8; i++) k.note(t + 1.0 + i * 0.06, { type: 'sine', freq: N(84 + [0, 4, 7, 12][i % 4]) * p, a: 0.002, hold: 0.02, r: 0.25, gain: 0.07 }, out);
  return 2.6;
}
function mission_failed(k, out, t, o) {
  const p = o.pitch;
  const notes = [67, 66, 65, 62];
  notes.forEach((m, i) => {
    const dur = i === 3 ? 1.3 : 0.3;
    brass(k, out, t + i * 0.34, [N(m), N(m - 3), N(m - 7)].map((f) => f * p), dur, 0.13, 1500);
  });
  k.tone(t + 1.02, { type: 'sine', f0: 70 * p, f1: 35 * p, dur: 1.0, gain: 0.8 }, out);
  return 2.4;
}
function wanted_up(k, out, t, o) {
  const p = o.pitch;
  // dissonant brass stab + low hit + rising whoosh
  brass(k, out, t, [N(50), N(51), N(57), N(63)].map((f) => f * p), 0.42, 0.16, 2000);
  k.tone(t, { type: 'sine', f0: 90 * p, f1: 42 * p, dur: 0.5, gain: 0.9 }, out);
  k.burst(t, { filter: 'bandpass', freq: 600, freq1: 2400, q: 2, dur: 0.35, gain: 0.25 }, out);
  return 0.6;
}
function wanted_lost(k, out, t, o) {
  const p = o.pitch;
  const seq = [[72, 0], [67, 0.12], [64, 0.24], [60, 0.36]];
  for (const [m, dt] of seq) k.note(t + dt, { type: 'triangle', freq: N(m) * p, a: 0.01, hold: 0.06, r: 0.3, gain: 0.25 }, out);
  brass(k, out, t + 0.48, [N(53), N(57), N(60), N(64)].map((f) => f * p), 0.9, 0.09, 1600);
  return 1.5;
}
function siren_chirp(k, out, t, o) {
  const p = o.pitch;
  const g = k.gain(0, out);
  const f = k.filter('bandpass', 1300, 1.2, g);
  const s = k.osc('square', 600 * p, t, 0.3, f);
  s.frequency.setValueAtTime(600 * p, t);
  s.frequency.exponentialRampToValueAtTime(1500 * p, t + 0.12);
  s.frequency.exponentialRampToValueAtTime(650 * p, t + 0.28);
  k.env(g.gain, t, 0.45, 0.01, 0.24, 0.04);
  return 0.32;
}
function tnt_fuse(k, out, t, o) {
  const dur = Math.max(0.3, Math.min(5, o.duration ?? 1.6));
  const g = k.gain(0, out);
  const f = k.filter('highpass', 2800, 0.7, g);
  k.noise(t, dur, f, 'white');
  const c = k.gain(1.2, out);
  k.noise(t, dur, k.filter('highpass', 1500, 0.7, c), 'crackle');
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.35, t + 0.08);
  g.gain.linearRampToValueAtTime(0.5, t + dur * 0.9);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  c.gain.setValueAtTime(1.2, t + dur * 0.9);
  c.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return dur;
}
function checkpoint(k, out, t, o) {
  const p = o.pitch;
  k.note(t, { type: 'sine', freq: 1318 * p, a: 0.002, hold: 0.04, r: 0.35, gain: 0.35 }, out);
  k.note(t + 0.07, { type: 'sine', freq: 1976 * p, a: 0.002, hold: 0.05, r: 0.45, gain: 0.3 }, out);
  k.note(t + 0.07, { type: 'triangle', freq: 988 * p, a: 0.002, hold: 0.05, r: 0.3, gain: 0.15 }, out);
  return 0.55;
}
function purchase(k, out, t, o) {
  const p = o.pitch;
  arp(k, out, t, [880, 1320].map((f) => f * p), 0.07, 'triangle', 0.3, 0.1);
  k.note(t + 0.16, { type: 'sine', freq: 2637 * p, a: 0.002, hold: 0.02, r: 0.4, gain: 0.18 }, out);
  k.note(t + 0.16, { type: 'sine', freq: 3520 * p, a: 0.002, hold: 0.02, r: 0.3, gain: 0.1 }, out);
  return 0.6;
}
function error(k, out, t, o) {
  const p = o.pitch;
  for (let i = 0; i < 2; i++) {
    const g = k.gain(0, out);
    const f = k.filter('lowpass', 1400, 1, g);
    k.osc('square', 155 * p, t + i * 0.14, 0.11, f);
    k.osc('square', 164 * p, t + i * 0.14, 0.11, f);
    k.env(g.gain, t + i * 0.14, 0.3, 0.005, 0.09, 0.02);
  }
  return 0.3;
}
function thunder(k, out, t, o) {
  const I = o.intensity ?? 1;
  const len = 3.5;
  const g = k.gain(0, out);
  const f = k.filter('lowpass', 900, 0.6, g);
  k.sweep(f.frequency, t, 1400, 120, len);
  k.noise(t, len, f, 'brown');
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(1.1 * I, t + 0.05);
  // rolling rumble: a few swells
  let tt = t + 0.25;
  for (let i = 0; i < 4; i++) {
    g.gain.linearRampToValueAtTime(R(0.4, 0.9) * I, tt);
    tt += R(0.3, 0.6);
  }
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  k.burst(t, { filter: 'bandpass', freq: 1800, q: 0.6, dur: 0.25, gain: 0.35 * I }, out);
  return len;
}
function radio_static(k, out, t, o) {
  const dur = o.duration ?? 0.28;
  k.burst(t, { filter: 'bandpass', freq: 2200, freq1: 900, q: 0.8, dur, gain: 0.35, attack: 0.01 }, out);
  const c = k.gain(0.6, out);
  k.noise(t, dur, c, 'crackle');
  c.gain.setValueAtTime(0.6, t);
  c.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return dur;
}

// ------------------------------------------------------------------------------------------------ table
const SFX = 'sfx', UI = 'ui';
/** name -> { fn, bus, range, prio, max, gain, verb, jitter } */
export const RECIPES = {
  gunshot_pistol: { fn: gunshot_pistol, range: 110, prio: 3, max: 6, gain: 0.58, verb: 0.35, jitter: 0.05 },
  gunshot_smg: { fn: gunshot_smg, range: 110, prio: 3, max: 8, gain: 0.62, verb: 0.3, jitter: 0.06 },
  gunshot_shotgun: { fn: gunshot_shotgun, range: 120, prio: 3, max: 4, gain: 0.6, verb: 0.4, jitter: 0.04 },
  gunshot_rifle: { fn: gunshot_rifle, range: 120, prio: 3, max: 8, gain: 0.53, verb: 0.35, jitter: 0.05 },
  gunshot_sniper: { fn: gunshot_sniper, range: 150, prio: 4, max: 3, gain: 0.55, verb: 0.5, jitter: 0.03 },
  rocket_launch: { fn: rocket_launch, range: 110, prio: 4, max: 3, gain: 0.93, verb: 0.3, jitter: 0.04 },
  explosion: { fn: explosion, range: 170, prio: 5, max: 5, gain: 0.55, verb: 0.55, jitter: 0.1 },
  grenade_bounce: { fn: grenade_bounce, range: 45, prio: 2, max: 4, gain: 0.6, verb: 0.1, jitter: 0.08 },
  punch: { fn: punch, range: 50, prio: 2, max: 4, gain: 0.42, verb: 0.1, jitter: 0.1 },
  melee_swing: { fn: melee_swing, range: 35, prio: 1, max: 4, gain: 0.9, verb: 0.05, jitter: 0.1 },
  reload: { fn: reload, range: 30, prio: 2, max: 3, gain: 0.7, verb: 0.05, jitter: 0.03 },
  empty_click: { fn: empty_click, range: 25, prio: 2, max: 3, gain: 0.6, verb: 0, jitter: 0.03 },
  bullet_impact: { fn: bullet_impact, range: 60, prio: 1, max: 6, gain: 0.45, verb: 0.15, jitter: 0.15 },
  glass_break: { fn: glass_break, range: 80, prio: 2, max: 4, gain: 0.9, verb: 0.25, jitter: 0.1 },
  block_break: { fn: block_break, range: 40, prio: 2, max: 4, gain: 0.75, verb: 0.08, jitter: 0.12 },
  block_place: { fn: block_place, range: 40, prio: 2, max: 4, gain: 0.7, verb: 0.05, jitter: 0.1 },
  block_hit: { fn: block_hit, range: 30, prio: 1, max: 3, gain: 0.68, verb: 0.03, jitter: 0.12 },
  footstep: { fn: footstep, range: 30, prio: 0, max: 6, gain: 0.32, verb: 0.02, jitter: 0.12 },
  jump: { fn: jump, range: 25, prio: 1, max: 2, gain: 1.1, verb: 0.02, jitter: 0.08 },
  land: { fn: land, range: 30, prio: 1, max: 3, gain: 0.6, verb: 0.04, jitter: 0.08 },
  splash: { fn: splash, range: 60, prio: 2, max: 4, gain: 0.7, verb: 0.1, jitter: 0.1 },
  car_door: { fn: car_door, range: 45, prio: 2, max: 3, gain: 0.7, verb: 0.1, jitter: 0.06 },
  horn: { fn: horn, range: 110, prio: 2, max: 6, gain: 0.45, verb: 0.2, jitter: 0.0 },
  crash: { fn: crash, range: 90, prio: 3, max: 4, gain: 0.57, verb: 0.25, jitter: 0.1 },
  tire_screech: { fn: tire_screech, range: 80, prio: 1, max: 4, gain: 1.0, verb: 0.1, jitter: 0.06 },
  car_alarm: { fn: car_alarm, range: 90, prio: 2, max: 2, gain: 0.5, verb: 0.2, jitter: 0 },
  pickup: { fn: pickup, bus: UI, prio: 3, max: 3, gain: 1.9, jitter: 0 },
  money: { fn: money, bus: UI, prio: 3, max: 3, gain: 0.6, jitter: 0 },
  hurt: { fn: hurt, range: 40, prio: 3, max: 3, gain: 0.9, verb: 0.05, jitter: 0.05 },
  death: { fn: death, range: 50, prio: 4, max: 2, gain: 0.7, verb: 0.15, jitter: 0 },
  ui_click: { fn: ui_click, bus: UI, prio: 5, max: 4, gain: 0.5, jitter: 0 },
  ui_open: { fn: ui_open, bus: UI, prio: 5, max: 2, gain: 0.75, jitter: 0 },
  mission_start: { fn: mission_start, bus: UI, prio: 6, max: 1, gain: 0.7, jitter: 0, duck: 1.4 },
  mission_passed: { fn: mission_passed, bus: UI, prio: 6, max: 1, gain: 0.75, jitter: 0, duck: 2.8 },
  mission_failed: { fn: mission_failed, bus: UI, prio: 6, max: 1, gain: 0.75, jitter: 0, duck: 2.5 },
  wanted_up: { fn: wanted_up, bus: UI, prio: 5, max: 2, gain: 0.7, jitter: 0, duck: 0.6 },
  wanted_lost: { fn: wanted_lost, bus: UI, prio: 5, max: 1, gain: 1.0, jitter: 0, duck: 1.2 },
  siren_chirp: { fn: siren_chirp, range: 120, prio: 2, max: 3, gain: 1.0, verb: 0.2, jitter: 0.02 },
  tnt_fuse: { fn: tnt_fuse, range: 40, prio: 3, max: 6, gain: 0.5, verb: 0.05, jitter: 0.05 },
  checkpoint: { fn: checkpoint, bus: UI, prio: 5, max: 2, gain: 0.8, jitter: 0 },
  purchase: { fn: purchase, bus: UI, prio: 5, max: 2, gain: 1.1, jitter: 0 },
  error: { fn: error, bus: UI, prio: 5, max: 2, gain: 0.5, jitter: 0 },
  thunder: { fn: thunder, bus: SFX, prio: 4, max: 2, gain: 0.9, verb: 0.3, jitter: 0.1, global: true },
  radio_static: { fn: radio_static, bus: UI, prio: 4, max: 2, gain: 0.35, jitter: 0 },
};

/** Friendly aliases so near-miss names from other modules still sound right. */
export const ALIASES = {
  gunshot: 'gunshot_pistol', shot: 'gunshot_pistol', gunshot_rpg: 'rocket_launch', rpg: 'rocket_launch', rocket: 'rocket_launch',
  gunshot_grenade: 'melee_swing', grenade_throw: 'melee_swing', throw: 'melee_swing', gunshot_bat: 'melee_swing', swing: 'melee_swing',
  gunshot_fist: 'melee_swing', gunshot_ar: 'gunshot_rifle', gunshot_assault: 'gunshot_rifle', gunshot_minigun: 'gunshot_smg',
  bat_hit: 'punch', hit: 'punch', melee_hit: 'punch', impact: 'bullet_impact', ricochet: 'bullet_impact',
  glass: 'glass_break', break: 'block_break', place: 'block_place', mine: 'block_hit', dig: 'block_hit', step: 'footstep',
  door: 'car_door', alarm: 'car_alarm', screech: 'tire_screech', skid: 'tire_screech', collision: 'crash',
  cash: 'money', coin: 'money', item: 'pickup', heal: 'pickup', health: 'pickup', armor: 'pickup', weapon_pickup: 'pickup',
  click: 'ui_click', ui_close: 'ui_click', open: 'ui_open', ui_hover: 'ui_click', buy: 'purchase', fail: 'error', denied: 'error',
  wanted: 'wanted_up', siren: 'siren_chirp', fuse: 'tnt_fuse', water: 'splash', explode: 'explosion', boom: 'explosion',
  mission_complete: 'mission_passed', mission_fail: 'mission_failed', static: 'radio_static',
};

/** Resolve a name through aliases; returns the canonical name or null. */
export function resolveSound(name) {
  if (RECIPES[name]) return name;
  const a = ALIASES[name];
  return a && RECIPES[a] ? a : null;
}

/** The §4.4 contract list (used by tests / debug). */
export const CONTRACT_SOUNDS = ['gunshot_pistol', 'gunshot_smg', 'gunshot_shotgun', 'gunshot_rifle', 'gunshot_sniper', 'rocket_launch',
  'explosion', 'grenade_bounce', 'punch', 'melee_swing', 'reload', 'empty_click', 'bullet_impact', 'glass_break', 'block_break',
  'block_place', 'block_hit', 'footstep', 'jump', 'land', 'splash', 'car_door', 'horn', 'crash', 'tire_screech', 'pickup', 'money',
  'hurt', 'death', 'ui_click', 'ui_open', 'mission_start', 'mission_passed', 'mission_failed', 'wanted_up', 'wanted_lost',
  'siren_chirp', 'tnt_fuse', 'checkpoint', 'purchase', 'error'];
