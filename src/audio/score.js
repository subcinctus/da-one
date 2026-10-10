// Dynamic police-chase score (owned by ATMOSPHERE). When the player is wanted and the radio is not playing, a tense
// procedural loop fades in and builds with the wanted level: pulsing bass, offbeat hats, four-on-the-floor kicks,
// snare, minor stabs, a racing arpeggio and finally a screaming lead. Fades out after the heat is lost.
import { INSTRUMENTS as INST } from './radio.js';
import { midiToFreq, makeImpulse } from './synth.js';

const LOOKAHEAD = 0.3;
const PROG = [45, 41, 43, 40];          // A  F  G  E  (A minor, dramatic)
const CHORDS = [[57, 60, 64], [57, 60, 65], [55, 59, 62], [56, 59, 64]];
const LEAD = [76, 77, 76, 74, 76, 72, 74, 71];

export class ChaseScore {
  constructor(kit, dest) {
    this.kit = kit;
    this.ctx = kit.ctx;
    this.out = kit.gain(0, dest);
    this.verb = this.ctx.createConvolver();
    this.verb.buffer = makeImpulse(this.ctx, 1.8, 3, 0.5);
    this.verb.connect(kit.gain(0.4, this.out));
    this.sends = { dry: this.out, verb: kit.gain(1, this.verb), delay: null };
    this.level = 0;          // current musical intensity 0..5
    this.active = false;
    this._step = 0; this._bar = 0; this._next = 0;
    this._quietFor = 0;
  }

  /** Target intensity (wanted stars, 0 = off). */
  setLevel(n, at = this.ctx.currentTime) {
    const lv = Math.max(0, Math.min(5, Math.round(n || 0)));
    if (lv === this.level) return;
    const prev = this.level;
    this.level = lv;
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(Math.max(0.0001, g.value), at);
    if (lv > 0) {
      g.linearRampToValueAtTime(0.42 + lv * 0.05, at + (prev === 0 ? 1.2 : 0.3));
      if (!this.active) { this.active = true; this._step = 0; this._bar = 0; this._next = at + 0.05; }
    } else {
      g.linearRampToValueAtTime(0.0001, at + 4);
    }
  }

  update(dt, muted) {
    if (!this.active) return;
    const now = this.ctx.currentTime;
    if (this.level === 0) {
      this._quietFor += dt;
      if (this._quietFor > 4.5) { this.active = false; return; }
    } else this._quietFor = 0;
    if (muted) { this._next = now + 0.1; return; }
    if (this._next < now - 0.25) this._next = now + 0.05;
    const lv = Math.max(1, this.level);
    const bpm = 116 + lv * 5;
    const sd = 60 / bpm / 4;
    let guard = 0;
    while (this._next < now + Math.max(LOOKAHEAD, dt * 2.5) && guard++ < 64) {
      this._play(this._next, this._step, this._bar, lv, sd);
      this._next += sd;
      if (++this._step >= 16) { this._step = 0; this._bar++; }
    }
  }

  _play(t, s, bar, lv, sd) {
    const k = this.kit, o = this.sends;
    const ci = bar % 4;
    const root = PROG[ci];
    const fill = ci === 3 && lv >= 4 && s >= 12;
    // pulsing bass: 8ths, 16ths from 4 stars
    if (lv >= 4 || s % 2 === 0) {
      const m = root + (s === 6 || s === 14 ? 12 : 0);
      INST.bass_saw(k, t, midiToFreq(m), sd * (lv >= 4 ? 0.9 : 1.6), s % 4 === 0 ? 0.95 : 0.7, o);
    }
    // hats: offbeats, then all 16ths
    if (s % 4 === 2 || (lv >= 3 && s % 2 === 1)) INST.hat(k, t, 0, sd, s % 4 === 2 ? 0.8 : 0.45, o);
    // kick four-on-the-floor
    if (lv >= 2 && s % 4 === 0 && !fill) INST.kick(k, t, 0, sd, 0.95, o);
    // snare backbeat + fills
    if (lv >= 3 && (s === 4 || s === 12) && !fill) INST.snare(k, t, 0, sd, 0.8, o);
    if (fill) INST.snare(k, t, 0, sd, 0.4 + (s - 12) * 0.15, o);
    // minor chord stabs
    if (lv >= 3 && (s === 0 || s === 10)) for (const m of CHORDS[ci]) INST.arp_saw(k, t, midiToFreq(m), sd * 2, 0.9, o);
    // racing arpeggio
    if (lv >= 4) { const ch = CHORDS[ci]; INST.arp_saw(k, t, midiToFreq(ch[s % 3] + 12), sd, 0.45, o); }
    // screaming lead at 5 stars
    if (lv >= 5 && s % 4 === 0) INST.lead_saw(k, t, midiToFreq(LEAD[(bar * 4 + s / 4) % LEAD.length]), sd * 3.5, 0.8, o);
    // crash on the downbeat of every 4 bars once it is intense
    if (lv >= 3 && ci === 0 && s === 0) INST.crash(k, t, 0, sd * 8, 0.5, o);
  }
}
