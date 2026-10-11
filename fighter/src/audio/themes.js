// Per-chapter music + acoustics. Minimal and tense: low taiko-like percussion, plucked pentatonic strings
// (guzheng / koto-like Karplus-Strong) and a bass drone. Intensity levels: 0 silent, 1 calm (between rooms),
// 2 fight, 3 boss. Patterns are 32 sixteenth-note steps (2 bars). Drum chars: X accent, x normal, o ghost, . rest.
// Ostinato / melody chars are scale-degree digits (0 = theme key) or '.' rest.

/** Default patterns per intensity; themes override single lanes. */
export const PATTERNS = {
  1: {
    taiko: 'X...............................',
    shime: '................................',
    ka: '................................',
    kane: '................................',
    low: '................................',
    osti: '................................',
    mel: 0.17,
  },
  2: {
    taiko: 'X.....x.X.......X.....x.X...o.o.',
    shime: '....x.......x.......x.......x.xo',
    ka: '..o...o...o...o...o...o...o...o.',
    kane: '................................',
    low: '................................',
    osti: '0.0.2.0.3.0.2.1.0.0.2.0.4.3.2.1.',
    mel: 0.22,
  },
  3: {
    taiko: 'X..x..x.X.x.X...X..x..x.X.x.XoXo',
    shime: 'x.o.x.o.x.o.x.o.x.o.x.o.x.xoxoxo',
    ka: '..o...o...o...o...o...o...o...o.',
    kane: 'X...............x...............',
    low: 'X.......X.......X.......X..x.x..',
    osti: '0.02.0.03.0.02.10.02.0.04.3.2.1.',
    mel: 0.28,
  },
};

/** Target gains per intensity: [drone, percussion, plucks, boss layer]. */
export const LAYER_GAINS = {
  0: [0, 0, 0, 0],
  1: [0.5, 0.5, 0.62, 0],
  2: [0.55, 0.85, 0.72, 0],
  3: [0.6, 1.0, 0.78, 0.55],
};

/**
 * Themes. key: MIDI root of the ostinato register; scale: pentatonic pitch classes; drone: MIDI of the drone root;
 * taiko: drum pitch Hz; surface: footstep type; room: reverb impulse ({ sec, decay, damp, wet }).
 */
export const THEMES = {
  title: {
    key: 50, scale: [0, 3, 5, 7, 10], bpm: 66, drone: 38, taiko: 60, seed: 3, surface: 'stone',
    room: { sec: 1.2, decay: 0.4, damp: 0.5, wet: 0.16 },
    over: { 1: { mel: 0.2 } },
  },
  laundromat: {
    // D minor pentatonic: tidy, wary
    key: 50, scale: [0, 3, 5, 7, 10], bpm: 84, drone: 38, taiko: 64, seed: 11, surface: 'tile',
    room: { sec: 0.9, decay: 0.28, damp: 0.6, wet: 0.14 },
    over: {},
  },
  market: {
    // E hirajoshi-like: lantern-lit, a little exotic; busier plucks
    key: 52, scale: [0, 2, 3, 7, 8], bpm: 92, drone: 40, taiko: 60, seed: 23, surface: 'wet',
    room: { sec: 0.7, decay: 0.18, damp: 0.7, wet: 0.08 },
    over: {
      1: { mel: 0.22 },
      2: { osti: '0.2.0.3.0.2.4.3.0.2.0.3.5.4.3.2.', mel: 0.27, ka: '..o.o...o...o.o...o.o...o...o.o.' },
      3: { mel: 0.32 },
    },
  },
  gym: {
    // C minor pentatonic: heavier drums, concrete room
    key: 48, scale: [0, 3, 5, 7, 10], bpm: 100, drone: 36, taiko: 56, seed: 37, surface: 'mat',
    room: { sec: 1.6, decay: 0.5, damp: 0.45, wet: 0.18 },
    over: {
      1: { taiko: 'X...............x...............' },
      2: { taiko: 'X..o..x.X..o....X..o..x.X.o.X.x.', osti: '0.0.0.2.0.0.3.2.0.0.0.2.4.3.2.0.', mel: 0.18 },
      3: { taiko: 'X.ox..x.X.x.X.o.X.ox..x.X.x.XxXx' },
    },
  },
  tower: {
    // A in-scale (miyako-bushi): darker, sparse, the final negotiation
    key: 45, scale: [0, 1, 5, 7, 8], bpm: 88, drone: 33, taiko: 58, seed: 53, surface: 'stone',
    room: { sec: 0.5, decay: 0.12, damp: 0.8, wet: 0.06 },
    over: {
      1: { mel: 0.13 },
      2: { osti: '0...1.0.3...2.1.0...1.0.4...3.2.', mel: 0.2 },
      3: { kane: 'X.......x.......X.......x.......' },
    },
  },
};

/** Resolve a theme's patterns for an intensity (defaults + overrides). */
export function patternsFor(theme, level) {
  const base = PATTERNS[level] || PATTERNS[1];
  const over = (theme && theme.over && theme.over[level]) || null;
  return over ? { ...base, ...over } : base;
}

/** Drum velocity of a pattern char. */
export const vel = (c) => (c === 'X' ? 1 : c === 'x' ? 0.7 : c === 'o' ? 0.38 : 0);
