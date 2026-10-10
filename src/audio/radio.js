// In-car radio (owned by ATMOSPHERE): procedurally composed stations (see music.js) rendered by small synth
// instruments and scheduled ahead on the AudioContext clock. Stations keep "broadcasting" while you are not listening:
// tuning in drops you mid-song, like a real radio.
import { STATIONS, makeSong, barEvents } from './music.js';
import { midiToFreq, makeImpulse } from './synth.js';

const LOOKAHEAD = 0.35;

// ------------------------------------------------------------------------------------------------ instruments
// fn(k, t, freq, dur, vel, o) where o = { dry, verb, delay } destination nodes.
function sendTo(k, src, o, verb = 0, delay = 0) {
  if (verb > 0 && o.verb) src.connect(k.gain(verb, o.verb));
  if (delay > 0 && o.delay) src.connect(k.gain(delay, o.delay));
}

const INST = {
  kick(k, t, f, d, v, o) {
    k.tone(t, { type: 'sine', f0: 155, f1: 44, sweep: 0.1, dur: 0.38, gain: 0.95 * v }, o.dry);
    k.burst(t, { filter: 'highpass', freq: 3500, q: 0.7, dur: 0.008, gain: 0.25 * v }, o.dry);
  },
  kick_boom(k, t, f, d, v, o) {
    const sh = k.shaper(1.8, o.dry);
    k.tone(t, { type: 'sine', f0: 120, f1: 42, sweep: 0.12, dur: 0.45, gain: 0.95 * v }, sh);
    k.burst(t, { filter: 'lowpass', freq: 1200, q: 0.7, dur: 0.02, gain: 0.4 * v }, o.dry);
  },
  kick_lofi(k, t, f, d, v, o) {
    const lp = k.filter('lowpass', 900, 0.7, o.dry);
    k.tone(t, { type: 'sine', f0: 98, f1: 44, sweep: 0.12, dur: 0.32, gain: 0.85 * v }, lp);
    k.burst(t, { filter: 'lowpass', freq: 600, q: 0.7, dur: 0.015, gain: 0.3 * v }, lp);
  },
  chip_kick(k, t, f, d, v, o) {
    k.tone(t, { type: k.nesTriangle(), f0: 220, f1: 48, sweep: 0.07, dur: 0.12, gain: 0.9 * v }, o.dry);
    k.burst(t, { filter: 'lowpass', freq: 2500, q: 0.7, dur: 0.02, gain: 0.3 * v }, o.dry);
  },
  snare(k, t, f, d, v, o) {
    const g = k.gain(1, o.dry);
    sendTo(k, g, o, 0.55);
    k.burst(t, { filter: 'bandpass', freq: 1900, q: 0.7, dur: 0.2, gain: 0.7 * v }, g);
    k.tone(t, { type: 'triangle', f0: 200, f1: 160, dur: 0.1, gain: 0.45 * v }, g);
  },
  snare_boom(k, t, f, d, v, o) {
    const g = k.gain(1, o.dry);
    sendTo(k, g, o, 0.18);
    k.burst(t, { filter: 'bandpass', freq: 1500, q: 0.6, dur: 0.17, gain: 0.75 * v }, g);
    k.burst(t, { filter: 'highpass', freq: 5000, q: 0.5, dur: 0.06, gain: 0.25 * v }, g);
    k.tone(t, { type: 'triangle', f0: 210, f1: 170, dur: 0.08, gain: 0.45 * v }, g);
  },
  rim(k, t, f, d, v, o) {
    const g = k.gain(1, o.dry);
    sendTo(k, g, o, 0.25);
    k.tone(t, { type: 'triangle', f0: 1650, dur: 0.035, gain: 0.35 * v }, g);
    k.burst(t, { filter: 'bandpass', freq: 2600, q: 1.5, dur: 0.05, gain: 0.45 * v }, g);
    k.burst(t, { filter: 'lowpass', freq: 3000, q: 0.5, dur: 0.12, gain: 0.25 * v }, g);
  },
  chip_snare(k, t, f, d, v, o) {
    k.burst(t, { filter: 'highpass', freq: 1200, q: 0.5, dur: 0.12, gain: 0.55 * v }, o.dry);
    k.tone(t, { type: 'square', f0: 260, f1: 180, dur: 0.05, gain: 0.2 * v }, o.dry);
  },
  hat(k, t, f, d, v, o) { k.burst(t, { filter: 'highpass', freq: 7200, q: 0.7, dur: 0.04, gain: 0.32 * v }, o.dry); },
  hat_soft(k, t, f, d, v, o) {
    const lp = k.filter('lowpass', 8500, 0.5, o.dry);
    k.burst(t, { filter: 'highpass', freq: 5500, q: 0.6, dur: 0.035, gain: 0.26 * v }, lp);
  },
  ohat(k, t, f, d, v, o) { k.burst(t, { filter: 'highpass', freq: 6500, q: 0.6, dur: 0.24, gain: 0.25 * v }, o.dry); },
  chip_hat(k, t, f, d, v, o) { k.burst(t, { filter: 'highpass', freq: 8500, q: 0.5, dur: 0.025, gain: 0.25 * v }, o.dry); },
  crash(k, t, f, d, v, o) {
    const g = k.gain(1, o.dry);
    sendTo(k, g, o, 0.3);
    k.burst(t, { filter: 'highpass', freq: 4200, q: 0.4, dur: 1.4, gain: 0.22 * v }, g);
  },
  swell(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.4);
    const hp = k.filter('highpass', 2500, 0.5, g);
    k.noise(t, d, hp, 'white');
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * v, t + d * 0.95);
    g.gain.linearRampToValueAtTime(0.0001, t + d);
  },
  bass_saw(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    const lp = k.filter('lowpass', 300, 4, g);
    lp.frequency.setValueAtTime(380 + 1600 * v, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.14);
    k.osc('sawtooth', f, t, d + 0.08, lp, -6);
    k.osc('sawtooth', f, t, d + 0.08, lp, 6);
    k.env(g.gain, t, 0.26 * v, 0.004, Math.max(0.02, d * 0.75), 0.06);
  },
  bass_sub(k, t, f, d, v, o) {
    const g = k.gain(0, k.shaper(1.4, o.dry));
    k.osc('sine', f, t, d + 0.1, g);
    k.osc('triangle', f * 2, t, d + 0.1, k.gain(0.18, g));
    k.env(g.gain, t, 0.5 * v, 0.008, Math.max(0.04, d * 0.85), 0.08);
  },
  chip_bass(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    k.osc(k.nesTriangle(), f, t, d + 0.03, g);
    k.env(g.gain, t, 0.45 * v, 0.002, Math.max(0.02, d * 0.85), 0.02);
  },
  bass_soft(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    const lp = k.filter('lowpass', 700, 0.7, g);
    k.osc('sine', f, t, d + 0.2, lp);
    k.osc('triangle', f, t, d + 0.2, k.gain(0.3, lp));
    k.env(g.gain, t, 0.55 * v, 0.02, Math.max(0.05, d * 0.8), 0.15);
  },
  pad(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.6);
    const lp = k.filter('lowpass', 1500, 0.8, g);
    k.osc('sawtooth', f, t, d + 0.8, lp, -11);
    k.osc('sawtooth', f, t, d + 0.8, lp, 0);
    k.osc('sawtooth', f, t, d + 0.8, lp, 12);
    k.env(g.gain, t, 0.05 * v, 0.35, Math.max(0.05, d - 0.35), 0.7, 0.8);
  },
  epiano(k, t, f, d, v, o, wobble = false, bright = 1) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.32);
    const out = wobble ? k.filter('lowpass', 2600, 0.6, g) : g;
    const car = k.osc('sine', f, t, d + 0.5, out);
    const mod = k.osc('sine', f, t, d + 0.5, null);
    const idx = k.gain(0, car.frequency);
    mod.connect(idx);
    idx.gain.setValueAtTime(f * 2.4 * bright * v, t);
    idx.gain.exponentialRampToValueAtTime(f * 0.15 + 1, t + 0.5);
    // bright "tine" transient
    const tg = k.gain(0, out);
    k.osc('sine', f * 4.02, t, 0.25, tg);
    k.perc(tg.gain, t, 0.035 * v * bright, 0.18);
    if (wobble) {
      const lfoGain = k.gain(9, car.detune);
      lfoGain.connect(mod.detune);
      k.osc('sine', 0.55 + Math.random() * 0.2, t, d + 0.5, lfoGain);
    }
    const hold = Math.max(0.41, d);
    g.gain.setValueAtTime(0.00001, t);
    g.gain.linearRampToValueAtTime(0.2 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.09 * v, t + 0.4);
    g.gain.setValueAtTime(0.09 * v, t + hold);
    g.gain.exponentialRampToValueAtTime(0.00001, t + hold + 0.35);
  },
  epiano_wobble(k, t, f, d, v, o) { INST.epiano(k, t, f, d, v, o, true, 0.8); },
  epiano_lead(k, t, f, d, v, o) { INST.epiano(k, t, f, Math.min(d, 0.6), v, o, false, 1.3); },
  lead_saw(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.35, 0.32);
    const lp = k.filter('lowpass', 2800, 1.6, g);
    const a = k.osc('sawtooth', f, t, d + 0.2, lp, -8);
    const b = k.osc('sawtooth', f, t, d + 0.2, lp, 8);
    const sq = k.osc('square', f * 0.5, t, d + 0.2, k.gain(0.3, lp));
    if (d > 0.25) {
      const vib = k.gain(0, a.detune);
      vib.connect(b.detune); vib.connect(sq.detune);
      k.osc('sine', 5.6, t, d + 0.2, vib);
      vib.gain.setValueAtTime(0, t);
      vib.gain.linearRampToValueAtTime(14, t + Math.min(d, 0.5));
    }
    k.env(g.gain, t, 0.085 * v, 0.012, Math.max(0.03, d * 0.9), 0.14, 0.85);
  },
  arp_saw(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.2, 0.25);
    const lp = k.filter('lowpass', 3800, 3, g);
    lp.frequency.setValueAtTime(3800, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.13);
    k.osc('sawtooth', f, t, 0.2, lp);
    k.perc(g.gain, t, 0.07 * v, 0.16);
  },
  chip_lead(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.08, 0.15);
    const s = k.osc(k.pulseWave(0.25), f, t, d + 0.05, g);
    if (d > 0.2) {
      const vib = k.gain(0, s.detune);
      k.osc('sine', 6.5, t, d + 0.05, vib);
      vib.gain.setValueAtTime(0, t + 0.12);
      vib.gain.linearRampToValueAtTime(22, t + 0.3);
    }
    k.env(g.gain, t, 0.085 * v, 0.003, Math.max(0.02, d * 0.92), 0.03, 0.75);
  },
  chip_arp(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    k.osc(k.pulseWave(0.125), f, t, d + 0.02, g);
    k.env(g.gain, t, 0.06 * v, 0.002, Math.max(0.01, d * 0.8), 0.01);
  },
  chip_echo(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0, 0.4);
    k.osc(k.pulseWave(0.5), f, t, d + 0.02, g);
    k.env(g.gain, t, 0.05 * v, 0.002, Math.max(0.01, d * 0.6), 0.03);
  },
  pluck(k, t, f, d, v, o) {
    const g = k.gain(0, o.dry);
    sendTo(k, g, o, 0.4, 0.2);
    const lp = k.filter('lowpass', 2200, 1, g);
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.35);
    k.osc('triangle', f, t, 0.9, lp);
    k.osc('sine', f * 2, t, 0.6, k.gain(0.25, lp));
    k.perc(g.gain, t, 0.22 * v, 0.75);
  },
  bell(k, t, f, d, v, o) {
    const g = k.gain(1, o.dry);
    sendTo(k, g, o, 0.5, 0.2);
    const partials = [[1, 0.16], [2.76, 0.06], [5.4, 0.03], [2, 0.05]];
    for (const [r, a] of partials) k.note(t, { type: 'sine', freq: f * r, a: 0.002, hold: 0.01, r: Math.min(1.6, 0.4 + d * 0.5) / Math.sqrt(r), gain: a * v }, g);
  },
};

export const INSTRUMENTS = INST;

// ------------------------------------------------------------------------------------------------ radio
export class Radio {
  /**
   * @param {Kit} kit synth kit on the live context
   * @param {AudioNode} dest music bus
   */
  constructor(kit, dest) {
    this.kit = kit;
    this.ctx = kit.ctx;
    this.dest = dest;
    this.stations = STATIONS.map((def, i) => ({
      def, index: i, seed: (Math.random() * 1e9) >>> 0, songIndex: 0, songStart: 0, song: null,
      epoch: this.ctx.currentTime - Math.random() * 80,
    }));
    this.current = -1;           // index of the station being rendered (-1 = none)
    this.selected = Math.floor(Math.random() * STATIONS.length); // remembered selection (-1 = OFF)
    this.on = false;             // radio powered (player in a vehicle or forced)
    this.override = -1;          // station forced regardless of the selection (title-screen music), -1 = none
    this.nowPlaying = null;      // { station, title, artist }
    this._bar = 0; this._step = 0; this._next = 0;
    this._buckets = null; this._bucketBar = -1;
    this._stationOut = null;

    // shared effects
    const k = kit;
    this.out = k.gain(0.0001, dest);
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = makeImpulse(this.ctx, 2.4, 2.8, 0.55);
    this.verb.connect(k.gain(0.32, this.out));
    this.delay = this.ctx.createDelay(2);
    this.delay.delayTime.value = 0.42;
    const fb = k.gain(0.33);
    const dlp = k.filter('lowpass', 2600, 0.5);
    this.delay.connect(dlp); dlp.connect(fb); fb.connect(this.delay);
    dlp.connect(k.gain(0.5, this.out));
    this.vinyl = null;
  }

  get stationName() { return this.selected >= 0 ? STATIONS[this.selected].name : 'Radio Off'; }

  /** Station actually rendered: the override (title music) or the listener's selection. */
  get playing() { return this.override >= 0 ? this.override : this.selected; }

  /** Force a station regardless of the selection (-1 clears). */
  setOverride(i) {
    const v = i >= 0 && i < STATIONS.length ? i : -1;
    if (v === this.override) return;
    this.override = v;
    if (this.on) this._tune(this.playing);
  }

  /** Power on/off (player in vehicle). */
  setPower(on) {
    if (on === this.on) return;
    this.on = on;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
    if (on) {
      this.out.gain.linearRampToValueAtTime(1, t + 0.35);
      this._tune(this.playing);
    } else {
      this.out.gain.linearRampToValueAtTime(0.0001, t + 0.5);
      this._tune(-1, 0.5);
    }
  }

  /** Select a station index (-1 = OFF). */
  select(i) {
    this.selected = i < 0 || i >= STATIONS.length ? -1 : i;
    if (this.on && this.override < 0) this._tune(this.selected);
  }

  /** Cycle to the next station, then OFF, then the first again. Returns the new station name. */
  next() {
    const n = STATIONS.length;
    this.select(this.selected === -1 ? 0 : this.selected + 1 >= n ? -1 : this.selected + 1);
    return this.stationName;
  }

  _seedFor(st, i) {
    let h = (st.seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
  }

  _ensureSong(st, now) {
    if (!st.song) { st.song = makeSong(st.def, this._seedFor(st, 0)); st.songStart = 0; st.songIndex = 0; }
    let elapsed = now - st.epoch;
    let guard = 0;
    while (elapsed > st.songStart + st.song.duration) {
      if (++guard > 3) {
        // been away a long time: jump straight into a fresh song at a random point
        st.songIndex += 1 + Math.floor(Math.random() * 5);
        st.song = makeSong(st.def, this._seedFor(st, st.songIndex));
        st.songStart = elapsed - Math.random() * st.song.duration * 0.6;
        break;
      }
      st.songStart += st.song.duration;
      st.songIndex++;
      st.song = makeSong(st.def, this._seedFor(st, st.songIndex));
    }
    return st.song;
  }

  _tune(index, fade = 0.15) {
    const t = this.ctx.currentTime;
    // fade out whatever is playing (dry + its effect sends together)
    if (this._stationOut) {
      const old = this._stationOut;
      for (const n of old.nodes) {
        n.gain.cancelScheduledValues(t);
        n.gain.setValueAtTime(n.gain.value, t);
        n.gain.linearRampToValueAtTime(0.0001, t + fade);
      }
      setTimeout(() => {
        try { for (const n of old.nodes) n.disconnect(); old.vinyl?.stop(); } catch (e) { /* already gone */ }
      }, (fade + 3) * 1000);
      this._stationOut = null;
      this._sends = null;
    }
    this.current = index;
    this.nowPlaying = null;
    if (index < 0) return;
    const k = this.kit;
    const st = this.stations[index];
    const start = t + 0.18; // after the tuning static
    const dry = k.gain(0.0001, this.out);
    const verb = k.gain(0.0001, this.verb);
    const delay = k.gain(0.0001, this.delay);
    const room = k.gain(0.12, verb); // a touch of room on everything
    dry.connect(room);
    const trim = st.def.gain ?? 1;
    for (const [n, v] of [[dry, trim], [verb, trim], [delay, trim]]) {
      n.gain.setValueAtTime(0.0001, t);
      n.gain.setValueAtTime(0.0001, start - 0.02);
      n.gain.linearRampToValueAtTime(v, start + 0.25);
    }
    this._stationOut = { nodes: [dry, verb, delay], vinyl: null };
    this._sends = { dry, verb, delay };
    if (st.def.insts.vinyl) {
      const vg = k.gain(0.5, dry);
      const bp = k.filter('bandpass', 2400, 0.6, vg);
      const src = k.noise(start, Infinity, bp, 'crackle', 0.9);
      const hiss = k.filter('highpass', 6000, 0.5, k.gain(0.025, dry));
      const src2 = k.noise(start, Infinity, hiss, 'white');
      this._stationOut.vinyl = { stop() { try { src.stop(); src2.stop(); } catch (e) { /* stopped */ } } };
    }
    const song = this._ensureSong(st, start);
    this._setSongFx(song);
    const pos = Math.max(0, start - st.epoch - st.songStart);
    const idx = Math.ceil(pos / song.stepDur);
    this._bar = Math.floor(idx / 16);
    this._step = idx % 16;
    this._next = start + (idx * song.stepDur - pos);
    this._song = song;
    this._st = st;
    this._bucketBar = -1;
    if (this._bar >= song.totalBars) this._advanceSong();
    this.nowPlaying = { station: st.def.name, genre: st.def.genre, title: song.title, artist: song.artist };
  }

  _setSongFx(song) {
    const beat = 60 / song.bpm;
    this.delay.delayTime.setTargetAtTime(beat * 0.75, this.ctx.currentTime, 0.05);
  }

  _advanceSong() {
    const st = this._st;
    st.songStart += st.song.duration;
    st.songIndex++;
    st.song = makeSong(st.def, this._seedFor(st, st.songIndex));
    this._song = st.song;
    this._bar = 0; this._step = 0;
    this._bucketBar = -1;
    this._setSongFx(st.song);
    this.nowPlaying = { station: st.def.name, genre: st.def.genre, title: st.song.title, artist: st.song.artist };
  }

  _bucket(bar) {
    if (this._bucketBar === bar && this._buckets) return this._buckets;
    const b = this._buckets || (this._buckets = Array.from({ length: 16 }, () => []));
    for (const l of b) l.length = 0;
    for (const e of barEvents(this._song, bar)) b[Math.min(15, Math.floor(e.step))].push(e);
    this._bucketBar = bar;
    return b;
  }

  /** Schedule notes up to the lookahead horizon. Call every frame. */
  update(frameDt = 0.016) {
    if (!this.on || this.current < 0 || !this._song) return;
    const now = this.ctx.currentTime;
    const horizon = now + Math.max(LOOKAHEAD, frameDt * 2.5);
    // fell far behind (tab hidden / long hitch): re-tune instead of spamming late notes
    if (this._next < now - 0.25) { this._tune(this.current, 0.05); return; }
    let guard = 0;
    while (this._next < horizon && guard++ < 256) {
      const song = this._song;
      const b = this._bucket(this._bar);
      const list = b[this._step];
      const sw = this._step % 2 === 1 ? (song.swing - 0.5) * 2 * song.stepDur * 0.5 : 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const t = Math.max(now, this._next + sw + (e.step - Math.floor(e.step)) * song.stepDur);
        const fn = INST[e.inst];
        if (!fn) continue;
        try { fn(this.kit, t, e.midi ? midiToFreq(e.midi) : 0, e.len * song.stepDur, e.vel, this._sends); } catch (err) { /* keep the show going */ }
      }
      this._next += song.stepDur;
      this._step++;
      if (this._step >= 16) {
        this._step = 0;
        this._bar++;
        if (this._bar >= song.totalBars) this._advanceSong();
      }
    }
  }
}
