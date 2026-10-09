// Continuous sound generators (owned by ATMOSPHERE): vehicle engines, police siren and named loops.
// Each builder takes (kit, dest) and returns a small controller; AudioSystem wraps them in lazy, positional handles.
import { pulseCurve } from './synth.js';

const TAU_FAST = 0.04;

/** Engine profiles. f = firing "fundamental" range (Hz) mapped from rpm01. */
const ENGINE = {
  car: { f0: 46, f1: 185, sub: 0.55, saw2: 0.3, lp0: 420, lp1: 2100, lpThr: 1100, q: 3.2, am: 0.32, rumble: 0.22, clatter: 0, drive: 2.4, level: 0.27 },
  truck: { f0: 33, f1: 112, sub: 0.8, saw2: 0.22, lp0: 300, lp1: 1250, lpThr: 700, q: 2.6, am: 0.42, rumble: 0.38, clatter: 0.16, drive: 3.2, level: 0.3 },
  bike: { f0: 62, f1: 290, sub: 0.25, saw2: 0.45, lp0: 650, lp1: 3600, lpThr: 1500, q: 4, am: 0.5, rumble: 0.12, clatter: 0, drive: 3.8, level: 0.25 },
};

/** Car/truck/bike engine: detuned saw + square sub through drive and a resonant low-pass, AM'd at the firing rate. */
function buildPistonEngine(k, dest, kind) {
  const c = ENGINE[kind] || ENGINE.car;
  const ctx = k.ctx, t = ctx.currentTime;
  const out = k.gain(0, dest);
  const am = k.gain(1 - c.am * 0.5, out);
  const lp = k.filter('lowpass', c.lp0, c.q, am);
  const drive = k.shaper(c.drive, lp);
  const mix = k.gain(0.5, drive);
  const o1 = k.osc('sawtooth', c.f0, t, Infinity, mix, -5);
  const o2 = k.osc('sawtooth', c.f0 * 1.005, t, Infinity, k.gain(c.saw2, mix), 9);
  const o3 = k.osc('square', c.f0 * 0.5, t, Infinity, k.gain(c.sub, mix), 3);
  // firing-rate amplitude modulation (the "chug")
  const lfo = k.osc('sine', c.f0 * 0.5, t, Infinity, k.gain(c.am * 0.5, am.gain));
  // low rumble
  const rg = k.gain(c.rumble, out);
  const rl = k.filter('lowpass', 220, 0.7, rg);
  k.noise(t, Infinity, rl, 'brown');
  // diesel clatter (truck)
  if (c.clatter > 0) {
    const cg = k.gain(0, out);
    const cl = k.filter('bandpass', 1500, 2.2, cg);
    k.noise(t, Infinity, cl, 'white');
    k.osc('square', c.f0, t, Infinity, k.gain(c.clatter * 0.5, cg.gain));
    cg.gain.value = c.clatter * 0.5;
  }
  return {
    out,
    set(rpm, thr, vol, at) {
      const f = c.f0 + (c.f1 - c.f0) * rpm;
      o1.frequency.setTargetAtTime(f, at, TAU_FAST);
      o2.frequency.setTargetAtTime(f * 1.005, at, TAU_FAST);
      o3.frequency.setTargetAtTime(f * 0.5, at, TAU_FAST);
      lfo.frequency.setTargetAtTime(f * 0.5, at, TAU_FAST);
      lp.frequency.setTargetAtTime(c.lp0 + (c.lp1 - c.lp0) * rpm + c.lpThr * thr, at, 0.06);
      rg.gain.setTargetAtTime(c.rumble * (0.6 + 0.6 * thr), at, 0.1);
      const level = c.level * (0.55 + 0.3 * thr + 0.25 * rpm) * vol;
      out.gain.setTargetAtTime(level, at, 0.05);
    },
  };
}

/** Helicopter: amplitude-modulated noise "whup-whup" (blade pulses) + turbine whine + low rotor drone. */
function buildHeli(k, dest) {
  const t = k.ctx.currentTime;
  const out = k.gain(0, dest);
  const am = k.gain(0.18, out);
  const bp = k.filter('bandpass', 420, 0.8, am);
  k.noise(t, Infinity, bp, 'pink');
  const lpn = k.filter('lowpass', 260, 0.7, am);
  k.noise(t, Infinity, lpn, 'brown');
  // blade pulse LFO: sine -> sharp positive pulses -> modulates the noise gain
  const lfo = k.osc('sine', 4, t, Infinity, null);
  const pulse = k.ctx.createWaveShaper();
  pulse.curve = pulseCurve(5);
  lfo.connect(pulse);
  const depth = k.gain(0.95, am.gain);
  pulse.connect(depth);
  // turbine whine
  const wg = k.gain(0.025, out);
  const whine = k.osc('sine', 2100, t, Infinity, wg);
  const whine2 = k.osc('sine', 3150, t, Infinity, k.gain(0.4, wg));
  // drone
  const drone = k.osc('triangle', 48, t, Infinity, k.gain(0.18, out));
  return {
    out,
    set(rpm, thr, vol, at) {
      const rate = 3 + rpm * 15.5;
      lfo.frequency.setTargetAtTime(rate, at, 0.15);
      bp.frequency.setTargetAtTime(330 + rpm * 260 + thr * 120, at, 0.1);
      whine.frequency.setTargetAtTime(1700 + rpm * 1300, at, 0.2);
      whine2.frequency.setTargetAtTime((1700 + rpm * 1300) * 1.5, at, 0.2);
      drone.frequency.setTargetAtTime(40 + rpm * 22, at, 0.2);
      wg.gain.setTargetAtTime(0.012 + rpm * 0.03, at, 0.2);
      out.gain.setTargetAtTime((0.25 + 0.45 * rpm + 0.15 * thr) * vol * 0.75, at, 0.08);
    },
  };
}

export function buildEngine(k, dest, kind) {
  return kind === 'heli' ? buildHeli(k, dest) : buildPistonEngine(k, dest, kind === 'truck' ? 'truck' : kind === 'bike' ? 'bike' : 'car');
}

/** Police siren: two oscillators swept by an LFO; wail (slow) or yelp (fast). */
export function buildSiren(k, dest) {
  const t = k.ctx.currentTime;
  const out = k.gain(0, dest);
  const bp = k.filter('bandpass', 1250, 0.9, out);
  const sh = k.shaper(1.6, bp);
  const pre = k.gain(0.5, sh);
  const o1 = k.osc('sawtooth', 1000, t, Infinity, pre);
  const o2 = k.osc('square', 500, t, Infinity, k.gain(0.35, pre));
  const lfo = k.osc('triangle', 0.28, t, Infinity, null);
  const d1 = k.gain(430, o1.frequency);
  const d2 = k.gain(215, o2.frequency);
  lfo.connect(d1); lfo.connect(d2);
  return {
    out,
    setMode(mode, at) {
      const yelp = mode === 'yelp';
      lfo.frequency.setTargetAtTime(yelp ? 3.8 : 0.28, at, 0.05);
      d1.gain.setTargetAtTime(yelp ? 330 : 430, at, 0.05);
      d2.gain.setTargetAtTime(yelp ? 165 : 215, at, 0.05);
      o1.frequency.setTargetAtTime(yelp ? 1100 : 1000, at, 0.05);
      o2.frequency.setTargetAtTime(yelp ? 550 : 500, at, 0.05);
    },
    set(vol, at) { out.gain.setTargetAtTime(0.42 * vol, at, 0.05); },
  };
}

// ------------------------------------------------------------------------------------------------ named loops
/** Each loop builder returns { out, set(vol, pitch, at) }. Unknown names fall back to retriggering a one-shot. */
export const LOOPS = {
  horn(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const f = k.filter('lowpass', 2300, 1.2, out);
    const a = k.osc('square', 404, t, Infinity, f, -6);
    const b = k.osc('square', 509, t, Infinity, f, 5);
    const c = k.osc('sawtooth', 404, t, Infinity, f, 9);
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.42 * v, at, 0.01); a.frequency.setTargetAtTime(404 * p, at, 0.02); b.frequency.setTargetAtTime(509 * p, at, 0.02); c.frequency.setTargetAtTime(404 * p, at, 0.02); } };
  },
  tire_screech(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const f = k.filter('bandpass', 1050, 6, out);
    const s = k.osc('sawtooth', 1020, t, Infinity, f);
    k.osc('sine', 13, t, Infinity, k.gain(30, s.frequency));
    const n = k.gain(0.35, out);
    const nf = k.filter('bandpass', 2600, 3, n);
    k.noise(t, Infinity, nf, 'white');
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.4 * v, at, 0.03); s.frequency.setTargetAtTime(1020 * p, at, 0.05); f.frequency.setTargetAtTime(1050 * p, at, 0.05); } };
  },
  fire(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const roar = k.filter('lowpass', 520, 0.7, k.gain(0.9, out));
    k.noise(t, Infinity, roar, 'brown');
    const cr = k.filter('highpass', 900, 0.7, k.gain(1.1, out));
    k.noise(t, Infinity, cr, 'crackle', 0.8);
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.5 * v, at, 0.1); roar.frequency.setTargetAtTime(520 * p, at, 0.1); } };
  },
  rain(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const hp = k.filter('highpass', 900, 0.5, out);
    const lp = k.filter('lowpass', 7500, 0.5, hp);
    k.noise(t, Infinity, lp, 'white');
    const pat = k.filter('bandpass', 3200, 0.8, k.gain(0.9, out));
    k.noise(t, Infinity, pat, 'crackle', 1.3);
    const low = k.filter('lowpass', 400, 0.6, k.gain(0.5, out));
    k.noise(t, Infinity, low, 'brown');
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.16 * v, at, 0.3); } };
  },
  wind(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const bp = k.filter('bandpass', 480, 1.4, out);
    k.noise(t, Infinity, bp, 'pink');
    k.osc('sine', 0.13, t, Infinity, k.gain(220, bp.frequency));
    k.osc('sine', 0.07, t, Infinity, k.gain(0.25, out.gain));
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.35 * v, at, 0.4); bp.frequency.setTargetAtTime(480 * p, at, 0.4); } };
  },
  tnt_fuse(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    k.noise(t, Infinity, k.filter('highpass', 2800, 0.7, k.gain(0.5, out)), 'white');
    k.noise(t, Infinity, k.filter('highpass', 1500, 0.7, k.gain(1.2, out)), 'crackle', 1.2);
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.55 * v, at, 0.03); } };
  },
  car_alarm(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    const f = k.filter('bandpass', 1500, 1.4, out);
    const s = k.osc('square', 1100, t, Infinity, f);
    k.osc('square', 2.3, t, Infinity, k.gain(200, s.frequency));
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.3 * v, at, 0.02); s.frequency.setTargetAtTime(1100 * p, at, 0.02); } };
  },
  underwater(k, dest) {
    const t = k.ctx.currentTime;
    const out = k.gain(0, dest);
    k.noise(t, Infinity, k.filter('lowpass', 380, 0.8, out), 'brown');
    return { out, set(v, p, at) { out.gain.setTargetAtTime(0.5 * v, at, 0.2); } };
  },
};
LOOPS.alarm = LOOPS.car_alarm;
LOOPS.burning = LOOPS.fire;
LOOPS.fuse = LOOPS.tnt_fuse;
LOOPS.screech = LOOPS.tire_screech;
LOOPS.skid = LOOPS.tire_screech;
LOOPS.water = LOOPS.underwater;
