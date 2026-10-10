// Procedural music composer for the radio (owned by ATMOSPHERE). Pure logic, no WebAudio: importable in Node.
//
// A station definition + seed -> a Song: key, tempo, a sectioned form (intro / verse / chorus / break / outro), chord
// progressions, motif-based evolving melodies, drum patterns with fills. barEvents(song, bar) returns the note events of
// one bar on a 16-step grid; the radio scheduler turns them into synth voices.
import { makeRng } from '../core/math.js';

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

/**
 * Station definitions. `form` lists section types; each section type defines which layers play.
 * Layers: kick, snare, hat, bass, chords, lead, arp, pad (bools); drum = pattern family. gain = output trim (mix balance).
 */
export const STATIONS = [
  {
    id: 'blockfm', name: 'Block FM', genre: 'Synthwave', gain: 1.0, bpm: [96, 114], swing: 0.5, scales: ['minor', 'dorian', 'harmonicMinor'],
    roots: [40, 42, 43, 45, 47], // E2 .. B2
    progressions: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 4], [0, 5, 3, 4], [5, 3, 0, 6]],
    sevenths: false, drum: 'synthwave', bassStyle: 'octave16', chordStyle: 'pad', leadInst: 'lead_saw', leadDensity: 0.5, arp: true,
    insts: { kick: 'kick', snare: 'snare', hat: 'hat', ohat: 'ohat', bass: 'bass_saw', chords: 'pad', lead: 'lead_saw', arp: 'arp_saw', ident: 'bell' },
    forms: [
      ['intro', 'A', 'B', 'A', 'break', 'B', 'outro'],
      ['intro', 'A', 'A', 'B', 'break', 'B', 'B', 'outro'],
    ],
    ident: [0, 4, 7, 11, 14],
    titles: [['Neon', 'Midnight', 'Chrome', 'Electric', 'Pixel', 'Turbo', 'Sunset', 'Laser', 'Velvet', 'Crystal'],
      ['Highway', 'Skyline', 'Overdrive', 'Horizon', 'Dreams', 'Boulevard', 'Heat', 'Runner', 'Signal', 'Avenue']],
    artists: ['The Voxels', 'Cube Driver', 'Synth Mason', 'LaserBlock', 'Midnight Miner', 'Obsidian Coast'],
  },
  {
    id: 'pixelbeats', name: 'Pixel Beats', genre: 'Hip-Hop', gain: 0.58, bpm: [84, 94], swing: 0.6, scales: ['minor', 'dorian'],
    roots: [36, 38, 40, 41, 43], // C2 .. G2
    progressions: [[0, 3, 4, 3], [0, 5, 3, 4], [1, 4, 0, 0], [0, 6, 5, 4], [3, 4, 0, 5]],
    sevenths: true, drum: 'boombap', bassStyle: 'sub', chordStyle: 'stabs', leadInst: 'epiano_lead', leadDensity: 0.32, arp: false,
    insts: { kick: 'kick_boom', snare: 'snare_boom', hat: 'hat_soft', ohat: 'ohat', bass: 'bass_sub', chords: 'epiano', lead: 'epiano_lead', arp: 'epiano', ident: 'epiano', vinyl: true },
    forms: [
      ['intro', 'A', 'B', 'A', 'B', 'outro'],
      ['intro', 'A', 'A', 'B', 'break', 'B', 'outro'],
    ],
    ident: [0, 2, 4, 9],
    titles: [['Concrete', 'Block', 'Corner', 'Brick', 'Gold', 'Paper', 'Late', 'Smooth', 'Heavy', 'Street'],
      ['Jungle', 'Hustle', 'Talk', 'Dreams', 'Chain', 'Flow', 'Season', 'Crown', 'Ride', 'Money']],
    artists: ['MC Pickaxe', 'Lil Cobble', 'DJ Redstone', 'Grand Theft Audio', 'Notorious B.L.O.C.K.', 'Big Bedrock'],
  },
  {
    id: 'eightbit', name: '8-Bit Radio', genre: 'Chiptune', gain: 0.95, bpm: [136, 160], swing: 0.5, scales: ['major', 'mixolydian', 'minor'],
    roots: [43, 45, 47, 48, 50], // G2 .. D3
    progressions: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [0, 3, 4, 4], [0, 3, 0, 4], [3, 4, 2, 5]],
    sevenths: false, drum: 'chip', bassStyle: 'chip', chordStyle: 'chiparp', leadInst: 'chip_lead', leadDensity: 0.62, arp: true,
    insts: { kick: 'chip_kick', snare: 'chip_snare', hat: 'chip_hat', ohat: 'chip_hat', bass: 'chip_bass', chords: 'chip_arp', lead: 'chip_lead', arp: 'chip_arp', ident: 'chip_lead' },
    forms: [
      ['intro', 'A', 'B', 'A', 'B', 'break', 'B', 'outro'],
      ['intro', 'A', 'A', 'B', 'B', 'outro'],
    ],
    ident: [0, 4, 7, 12, 16],
    titles: [['Super', 'Mega', 'Turbo', 'Hyper', 'Pixel', 'Power', 'Ultra', 'Retro', 'Star', 'Final'],
      ['Quest', 'Dash', 'Jump', 'Castle', 'Rush', 'Level', 'Boss', 'Coin', 'Warp', 'Combo']],
    artists: ['Bit Crusher', 'Chip Tunes Inc.', 'The 8-Bit Bandits', 'NES Wizard', 'Square Wave', 'Creeper Cartridge'],
  },
  {
    id: 'nightdrive', name: 'Night Drive', genre: 'Lo-Fi', gain: 0.72, bpm: [70, 82], swing: 0.62, scales: ['major', 'dorian'],
    roots: [38, 40, 41, 43, 45],
    progressions: [[3, 2, 1, 0], [0, 5, 1, 4], [1, 4, 0, 5], [3, 4, 2, 5], [0, 3, 1, 4]],
    sevenths: true, drum: 'lofi', bassStyle: 'soft', chordStyle: 'lofi', leadInst: 'pluck', leadDensity: 0.28, arp: false,
    insts: { kick: 'kick_lofi', snare: 'rim', hat: 'hat_soft', ohat: 'hat_soft', bass: 'bass_soft', chords: 'epiano_wobble', lead: 'pluck', arp: 'pluck', ident: 'pluck', vinyl: true },
    forms: [
      ['intro', 'A', 'B', 'A', 'B', 'outro'],
      ['intro', 'A', 'break', 'B', 'A', 'outro'],
    ],
    ident: [7, 4, 2, 0],
    titles: [['Rainy', 'Quiet', 'Late', 'Sleepy', 'Soft', 'Blue', 'Faded', 'Warm', 'Hazy', 'Distant'],
      ['Streetlights', 'Window', 'Coffee', 'Taxi', 'Rooftop', 'Memories', 'Drive', 'Neon', 'Avenue', 'Night']],
    artists: ['lofi miner', 'chillblock', 'sleepy crafter', 'nocturne', 'cube & coffee', 'tiny lanterns'],
  },
];

// Section type -> bars + layers
const SECTION = {
  ident: { bars: 2, layers: { ident: true, pad: true } },
  intro: { bars: 4, layers: { hat: true, chords: true, bass: false, kick: false, snare: false, lead: false, arp: true } },
  A: { bars: 8, layers: { kick: true, snare: true, hat: true, bass: true, chords: true, lead: true, arp: false } },
  B: { bars: 8, layers: { kick: true, snare: true, hat: true, ohat: true, bass: true, chords: true, lead: true, arp: true } },
  break: { bars: 4, layers: { chords: true, lead: true, bass: false, kick: false, snare: false, hat: false } },
  outro: { bars: 4, layers: { kick: true, hat: true, bass: true, chords: true, lead: false } },
};

const DRUMS = {
  synthwave: {
    kickA: [0, 8, 10], kickB: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14], hat16: true, ohat: [2, 6, 10, 14],
  },
  boombap: {
    kickA: [0, 7, 10], kickB: [0, 3, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ghost: [15, 9], ohat: [14],
  },
  chip: {
    kickA: [0, 8], kickB: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ohat: [6, 14],
  },
  lofi: {
    kickA: [0, 9], kickB: [0, 7, 9], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], ghost: [11], ohat: [],
  },
};

export function stationTitle(def, rng) {
  const [a, b] = def.titles;
  return `${a[Math.floor(rng() * a.length)]} ${b[Math.floor(rng() * b.length)]}`;
}

/** Degrees of a chord built on scale degree `deg` (triad or 7th, in scale steps). */
function chordDegrees(deg, sevenths) {
  return sevenths ? [deg, deg + 2, deg + 4, deg + 6] : [deg, deg + 2, deg + 4];
}

/** Scale degree (can be negative / > 6) -> MIDI note relative to the key root. */
export function degreeToMidi(scale, root, deg) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const idx = ((deg % n) + n) % n;
  return root + oct * 12 + scale[idx];
}

/** Melody motif: 16-step rhythm with relative scale-degree contour. */
function makeMotif(rng, density, energetic) {
  const notes = [];
  let deg = [0, 2, 4][Math.floor(rng() * 3)];
  let step = rng() < 0.7 ? 0 : 2;
  while (step < 16) {
    notes.push({ step, deg });
    // rhythm: 8ths mostly, 16ths sometimes, longer notes when sparse
    const r = rng();
    let adv;
    if (r < density * 0.35) adv = 1;
    else if (r < density) adv = 2;
    else if (r < density + 0.25) adv = 3;
    else adv = 4;
    if (energetic && adv > 2 && rng() < 0.5) adv = 2;
    step += adv;
    // contour: mostly steps, sometimes leaps, gently pulled toward the middle
    const leap = rng() < 0.18;
    let move = leap ? (rng() < 0.5 ? -3 : 3) + (rng() < 0.5 ? 1 : 0) : (rng() < 0.5 ? -1 : 1) * (rng() < 0.75 ? 1 : 2);
    if (deg > 6) move = -Math.abs(move);
    if (deg < -1) move = Math.abs(move);
    deg += move;
  }
  // lengths = gap to next note (cap)
  for (let i = 0; i < notes.length; i++) {
    const next = i + 1 < notes.length ? notes[i + 1].step : 16;
    notes[i].len = Math.max(1, Math.min(4, next - notes[i].step));
  }
  return notes;
}

/** Snap a scale degree to the nearest chord tone of `chord` (array of degrees). */
function snapToChord(deg, chord) {
  let best = deg, bd = 99;
  for (const c of chord) {
    for (let o = -14; o <= 14; o += 7) {
      const d = Math.abs(c + o - deg);
      if (d < bd) { bd = d; best = c + o; }
    }
  }
  return best;
}

/**
 * Build a song. Returns { def, seed, title, artist, bpm, swing, root, scale, sections[], bars[], totalBars, stepDur, barDur, duration }.
 * bars[i] = { section, sectionIndex, barInSection, chordDeg, chord (degrees), layers, fill, prevChord }.
 */
export function makeSong(def, seed) {
  const rng = makeRng(seed >>> 0);
  const bpm = Math.round(def.bpm[0] + rng() * (def.bpm[1] - def.bpm[0]));
  const root = def.roots[Math.floor(rng() * def.roots.length)];
  const scaleName = def.scales[Math.floor(rng() * def.scales.length)];
  const scale = SCALES[scaleName];
  const form = ['ident', ...def.forms[Math.floor(rng() * def.forms.length)]];
  const progA = def.progressions[Math.floor(rng() * def.progressions.length)];
  let progB = def.progressions[Math.floor(rng() * def.progressions.length)];
  if (progB === progA) progB = def.progressions[(def.progressions.indexOf(progA) + 1) % def.progressions.length];
  const motifs = {
    A: makeMotif(rng, def.leadDensity, false),
    B: makeMotif(rng, Math.min(0.9, def.leadDensity + 0.2), true),
    break: makeMotif(rng, def.leadDensity * 0.6, false),
  };
  const kickVariant = rng() < 0.5;
  const bars = [];
  const sections = [];
  form.forEach((type, si) => {
    const sd = SECTION[type];
    const prog = type === 'B' ? progB : progA;
    const start = bars.length;
    sections.push({ type, start, bars: sd.bars });
    for (let b = 0; b < sd.bars; b++) {
      const chordDeg = type === 'ident' ? 0 : prog[b % prog.length];
      // second half of 8-bar A sections: turnaround variation on the last bar
      let deg = chordDeg;
      if (sd.bars === 8 && b === 7 && type === 'A' && rng() < 0.5) deg = 4;
      bars.push({
        section: type, sectionIndex: si, barInSection: b, chordDeg: deg, chord: chordDegrees(deg, def.sevenths),
        layers: sd.layers, fill: b === sd.bars - 1 && si < form.length - 1 && type !== 'ident' && type !== 'intro' ? (rng() < 0.7) : false,
        last: si === form.length - 1 && b === sd.bars - 1,
      });
    }
  });
  const stepDur = 60 / bpm / 4;
  const barDur = stepDur * 16;
  const song = {
    def, seed: seed >>> 0, bpm, swing: def.swing, root, scaleName, scale, form, sections, bars, motifs, kickVariant,
    title: stationTitle(def, rng), artist: def.artists[Math.floor(rng() * def.artists.length)],
    totalBars: bars.length, stepDur, barDur, duration: bars.length * barDur, _cache: new Map(), _mrng: seed ^ 0x9e3779b9,
  };
  return song;
}

/** Melody notes for a bar: motif realised over the bar's chord with phrase-position variations. */
function melodyBar(song, bar, barIndex) {
  const motif = song.motifs[bar.section] || song.motifs.A;
  const rng = makeRng((song.seed * 31 + barIndex * 977) >>> 0);
  const pos = bar.barInSection % 4;
  const half = Math.floor(bar.barInSection / 4);
  const out = [];
  const lift = bar.section === 'B' ? 2 : 0;
  let notes = motif;
  if (pos === 3) {
    // answer phrase: first half of the motif then a long resolving note
    notes = motif.filter((n) => n.step < 8);
    // long resolving note: the tonic at the end of the section, else the chord root (kept near the motif's register)
    let avg = 0;
    for (const n of motif) avg += n.deg;
    avg = avg / Math.max(1, motif.length) + lift;
    let target = half === 1 ? 0 : bar.chordDeg;
    while (target < avg - 3.5) target += 7;
    while (target > avg + 3.5) target -= 7;
    out.push({ step: 8, deg: target, len: 6, accent: true });
  }
  for (const n of notes) {
    let deg = n.deg + lift;
    if (pos === 2) deg += 2; // sequence up a third
    if (pos === 1 && n === notes[notes.length - 1]) deg += rng() < 0.5 ? 1 : -1;
    if (half === 1 && rng() < 0.18) continue; // drop a note for variety in the second phrase
    let absDeg = deg + bar.chordDeg;
    if (n.step % 8 === 0) absDeg = snapToChord(absDeg, bar.chord);
    out.push({ step: n.step, deg: absDeg, len: n.len, accent: n.step % 4 === 0 });
  }
  // occasional passing-note ornament in the second phrase
  if (half === 1 && rng() < 0.35 && out.length) {
    const n = out[Math.floor(rng() * out.length)];
    if (n.len >= 2 && n.step + 1 < 16) { n.len = 1; out.push({ step: n.step + 1, deg: n.deg + 1, len: 1, accent: false }); }
  }
  out.sort((a, b) => a.step - b.step);
  return out;
}

/**
 * Note events for bar `barIndex`: [{ step (0..15, may be fractional for 32nds), inst, midi, len (steps), vel, kind }].
 * Cached per song.
 */
export function barEvents(song, barIndex) {
  const cached = song._cache.get(barIndex);
  if (cached) return cached;
  const def = song.def;
  const bar = song.bars[barIndex];
  const ev = [];
  if (!bar) return ev;
  const L = bar.layers;
  const I = def.insts;
  const S = song.scale, R0 = song.root;
  const D = DRUMS[def.drum];
  const rng = makeRng((song.seed * 7919 + barIndex * 104729) >>> 0);
  const isB = bar.section === 'B';
  const fadeOut = bar.section === 'outro' ? 1 - bar.barInSection / (SECTION.outro.bars + 0.5) : 1;

  if (bar.section === 'ident') {
    // station ident: bell-like logo over a swelling pad
    if (bar.barInSection === 0) {
      def.ident.forEach((d, i) => ev.push({ step: i * 2, inst: I.ident, midi: degreeToMidi(S, R0 + 24, d), len: i === def.ident.length - 1 ? 14 : 2, vel: 0.8 }));
      ev.push({ step: 0, inst: 'swell', midi: 0, len: 28, vel: 0.6 });
    }
    return cacheIt(song, barIndex, ev);
  }

  // ---- drums
  const fill = bar.fill;
  if (L.kick) {
    const pat = isB || song.kickVariant ? D.kickB : D.kickA;
    for (const s of pat) if (!(fill && s >= 12)) ev.push({ step: s, inst: I.kick, midi: 0, len: 1, vel: (s % 4 === 0 ? 1 : 0.8) * fadeOut });
  }
  if (L.snare) {
    for (const s of D.snare) if (!(fill && s >= 12)) ev.push({ step: s, inst: I.snare, midi: 0, len: 1, vel: 0.95 });
    if (D.ghost) for (const s of D.ghost) if (rng() < 0.45) ev.push({ step: s, inst: I.snare, midi: 0, len: 1, vel: 0.28 });
  }
  if (fill && (L.snare || L.kick)) {
    const n = rng() < 0.5 ? [12, 13, 14, 15] : [12, 14, 15];
    n.forEach((s, i) => ev.push({ step: s, inst: I.snare, midi: 0, len: 1, vel: 0.5 + i * 0.15 }));
  }
  if (L.hat) {
    const pat = D.hat16 && isB ? [0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15] : D.hat;
    for (const s of pat) {
      if (fill && s >= 12) continue;
      ev.push({ step: s, inst: I.hat, midi: 0, len: 1, vel: (s % 4 === 2 ? 0.75 : 0.5) * (0.85 + rng() * 0.3) * fadeOut });
    }
  }
  if (L.ohat && isB && D.ohat) for (const s of D.ohat) if (rng() < 0.6 && !(fill && s >= 12)) ev.push({ step: s, inst: I.ohat, midi: 0, len: 2, vel: 0.5 });
  if (bar.barInSection === 0 && (isB || bar.section === 'A') && song.sections[bar.sectionIndex - 1]?.type !== bar.section) {
    ev.push({ step: 0, inst: 'crash', midi: 0, len: 8, vel: 0.6 });
  }

  // ---- bass
  const rootDeg = bar.chordDeg;
  const bassMidi = degreeToMidi(S, R0, rootDeg) - (degreeToMidi(S, R0, rootDeg) - R0 > 7 ? 12 : 0);
  if (L.bass) {
    if (def.bassStyle === 'octave16') {
      for (let s = 0; s < 16; s++) ev.push({ step: s, inst: I.bass, midi: bassMidi + (s % 2 ? 12 : 0), len: 1, vel: (s % 4 === 0 ? 0.95 : 0.7) * fadeOut });
    } else if (def.bassStyle === 'sub') {
      const pat = [[0, 3], [7, 1], [10, 4]];
      for (const [s, l] of pat) ev.push({ step: s, inst: I.bass, midi: bassMidi, len: l, vel: 0.95 * fadeOut });
      if (rng() < 0.4) ev.push({ step: 14, inst: I.bass, midi: degreeToMidi(S, R0, rootDeg + 4) - 12, len: 2, vel: 0.7 * fadeOut });
    } else if (def.bassStyle === 'chip') {
      const fifth = degreeToMidi(S, R0, rootDeg + 4) - (degreeToMidi(S, R0, rootDeg + 4) - R0 > 9 ? 12 : 0);
      for (let s = 0; s < 16; s += 2) ev.push({ step: s, inst: I.bass, midi: s % 8 === 6 ? fifth : bassMidi + (s % 4 === 2 ? 12 : 0), len: 2, vel: 0.9 * fadeOut });
    } else {
      ev.push({ step: 0, inst: I.bass, midi: bassMidi, len: 6, vel: 0.9 * fadeOut });
      ev.push({ step: 8, inst: I.bass, midi: bassMidi, len: 3, vel: 0.75 * fadeOut });
      if (rng() < 0.5) ev.push({ step: 13, inst: I.bass, midi: degreeToMidi(S, R0, rootDeg + 2) - 12, len: 3, vel: 0.6 * fadeOut });
    }
  }

  // ---- chords (voiced around MIDI 60)
  if (L.chords) {
    const notes = bar.chord.map((d) => {
      let m = degreeToMidi(S, R0 + 12, d);
      while (m < 55) m += 12;
      while (m > 71) m -= 12;
      return m;
    }).sort((a, b) => a - b);
    const style = def.chordStyle;
    if (style === 'pad') {
      for (const m of notes) ev.push({ step: 0, inst: I.chords, midi: m, len: 16, vel: 0.7 * fadeOut });
    } else if (style === 'stabs') {
      const hits = rng() < 0.5 ? [[0, 3], [6, 2], [10, 4]] : [[0, 6], [10, 3]];
      for (const [s, l] of hits) for (const m of notes) ev.push({ step: s, inst: I.chords, midi: m, len: l, vel: 0.42 * fadeOut });
    } else if (style === 'lofi') {
      for (let i = 0; i < notes.length; i++) ev.push({ step: i * 0.5, inst: I.chords, midi: notes[i], len: 14, vel: 0.5 * fadeOut });
      if (rng() < 0.5) for (const m of notes) ev.push({ step: 10, inst: I.chords, midi: m, len: 5, vel: 0.32 * fadeOut });
    } else if (style === 'chiparp') {
      // fast 32nd-note arpeggio across the chord (classic chiptune "fake chord")
      const seq = [notes[0], notes[1], notes[2] ?? notes[0] + 12];
      for (let s = 0; s < 32; s++) ev.push({ step: s / 2, inst: I.chords, midi: seq[s % 3], len: 0.5, vel: 0.45 * fadeOut });
    }
  }
  // ---- arpeggio (synthwave / chip B sections)
  if (L.arp && def.arp && def.chordStyle !== 'chiparp') {
    const up = bar.chord.map((d) => degreeToMidi(S, R0 + 24, d));
    const seq = [...up, up[1] + 12, up[2] + 12];
    for (let s = 0; s < 16; s++) ev.push({ step: s, inst: I.arp, midi: seq[(s + (barIndex % 2) * 2) % seq.length], len: 1, vel: (s % 4 === 0 ? 0.6 : 0.4) * fadeOut });
  } else if (L.arp && def.chordStyle === 'chiparp' && isB) {
    // echo arps an octave up on chip B sections
    const up = bar.chord.map((d) => degreeToMidi(S, R0 + 36, d));
    for (let s = 0; s < 16; s += 2) ev.push({ step: s, inst: 'chip_echo', midi: up[(s / 2) % up.length], len: 1, vel: 0.22 });
  }

  // ---- lead melody
  if (L.lead) {
    const leadRoot = R0 + 24;
    const sparse = bar.section === 'break' || bar.section === 'intro';
    for (const n of melodyBar(song, bar, barIndex)) {
      if (sparse && n.step % 4 !== 0) continue;
      let m = degreeToMidi(S, leadRoot, n.deg);
      while (m > 86) m -= 12;
      while (m < 62) m += 12;
      ev.push({ step: n.step, inst: I.lead, midi: m, len: n.len, vel: (n.accent ? 0.85 : 0.68) * fadeOut });
    }
  }
  return cacheIt(song, barIndex, ev);
}

function cacheIt(song, i, ev) {
  if (song._cache.size > 64) song._cache.clear();
  song._cache.set(i, ev);
  return ev;
}
