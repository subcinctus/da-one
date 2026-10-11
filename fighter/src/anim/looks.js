// Fighter looks: palettes, proportions, masks and accessories per preset (FIGHTER.md §5).
// Soft muted palettes with ONE accent colour each; `look.colors` overrides palette entries, `look.seed` varies thugs.
import { makeRng } from '../core/math.js';

/**
 * Palette keys: skin, top (tunic / vest / jacket), top2 (secondary panels, sleeves), trim (collar, lapels),
 * trousers, sash, wrap (forearm / shin bandages), shoe, hair, mask, maskDark (eye slits), accent (stripe, trails).
 * Shape: scale (overall), girth (torso + limbs), shoulder (chest top width), belly (torso depth), arm, leg, head, hand.
 */
export const PRESETS = {
  player: {
    pal: { skin: 0xc99a76, top: 0xd8d1c1, top2: 0xc9c1af, trim: 0x2f6f5c, trousers: 0x35383f, sash: 0x3e9e7e, wrap: 0xe2dccd, shoe: 0x2a2b30, hair: 0x1c1a19, mask: 0xf4f0e8, maskDark: 0x16181d, accent: 0x46b08c },
    shape: { scale: 1, girth: 1, shoulder: 1, belly: 1, arm: 1, leg: 1, head: 1, hand: 1 },
    top: 'tunic', sleeves: 'short', hair: 'topknot',
    mask: { kind: 'porcelain', stripe: 'tear', slant: 7, brow: 0.012, ridge: 0.012 },
    flaps: { front: [0.27], back: [0.29], width: 0.2 }, tails: [0.2, 0.19],
  },
  thug: {
    pal: { skin: 0xb88a68, top: 0x55657e, top2: 0x4a5870, trim: 0x635b52, trousers: 0x696865, sash: 0x8c3f32, wrap: 0xb7ad99, shoe: 0x262626, hair: 0x221e1b, mask: 0xa79a84, maskDark: 0x1d1d1f, accent: 0xb5503c },
    shape: { scale: 1, girth: 1.04, shoulder: 1.02, belly: 1.05, arm: 1.02, leg: 1, head: 1, hand: 1 },
    top: 'tunic', sleeves: 'short', hair: 'short',
    mask: { kind: 'cloth', stripe: 'seam', slant: 0, brow: 0.004, ridge: 0.006 },
    flaps: { front: [0.22], back: [0.24], width: 0.2 }, tails: [0.16, 0.14],
  },
  brawler: {
    pal: { skin: 0xb98563, top: 0x7a3b36, top2: 0x69332f, trim: 0x655b53, trousers: 0x686a5d, sash: 0x9e3a2c, wrap: 0xcfc4ae, shoe: 0x272522, hair: 0x1b1816, mask: 0x4c4f55, maskDark: 0x121315, accent: 0xc0432f },
    shape: { scale: 1.05, girth: 1.14, shoulder: 1.22, belly: 1.1, arm: 1.4, leg: 1.1, head: 0.98, hand: 1.2 },
    top: 'vest', sleeves: 'none', hair: 'short',
    mask: { kind: 'half', stripe: 'center', slant: 12, brow: 0.018, ridge: 0.01 },
    flaps: { front: [0.2], back: [0.24], width: 0.22 }, tails: [0.18, 0.16],
  },
  swift: {
    pal: { skin: 0xc49a78, top: 0x5f7f86, top2: 0x536f75, trim: 0xb6893f, trousers: 0x62696f, sash: 0xc58c3b, wrap: 0xd6cfbf, shoe: 0x232528, hair: 0x505f64, mask: 0xd9d4ca, maskDark: 0x15171a, accent: 0xe0a347 },
    shape: { scale: 0.98, girth: 0.88, shoulder: 0.94, belly: 0.92, arm: 0.88, leg: 0.92, head: 0.98, hand: 0.95 },
    top: 'tunic', sleeves: 'short', hair: 'hood',
    mask: { kind: 'narrow', stripe: 'diagonal', slant: 16, brow: 0.01, ridge: 0.016 },
    flaps: { front: [0.3], back: [0.2, 0.18], width: 0.18 }, tails: [0.26, 0.25],
  },
  heavy: {
    pal: { skin: 0xa97c5e, top: 0x5c6449, top2: 0x4f5640, trim: 0x66574b, trousers: 0x626469, sash: 0x6b2f2a, wrap: 0xbcb19b, shoe: 0x232323, hair: 0x1a1817, mask: 0xd8cdb6, maskDark: 0x1b1a19, accent: 0xa8432f },
    shape: { scale: 1.06, girth: 1.32, shoulder: 1.25, belly: 1.4, arm: 1.3, leg: 1.22, head: 1.03, hand: 1.15 },
    top: 'padded', sleeves: 'short', hair: 'bald',
    mask: { kind: 'stout', stripe: 'brow', slant: 0, brow: 0.02, ridge: 0.008 },
    flaps: { front: [0.24], back: [0.26], width: 0.26 }, tails: [0.15, 0.14],
  },
  tadao: {
    pal: { skin: 0xd0a682, top: 0x3a3e46, top2: 0xe6e3da, trim: 0x2a2d33, trousers: 0x33363c, sash: 0x2a2d33, wrap: 0xe6e3da, shoe: 0x1b1b1d, hair: 0x18181a, mask: 0xeee8da, maskDark: 0x1b1c20, accent: 0x7a2630 },
    shape: { scale: 0.99, girth: 0.95, shoulder: 0.96, belly: 1.0, arm: 0.92, leg: 0.95, head: 1.0, hand: 0.95 },
    top: 'suitvest', sleeves: 'long', hair: 'slick', tie: true, ledger: true,
    mask: { kind: 'spectacles', stripe: 'none', slant: 0, brow: 0.008, ridge: 0.01 },
    flaps: null, tails: null,
  },
  madame_shu: {
    pal: { skin: 0xd8b08e, top: 0x1f5b61, top2: 0xe3d9c6, trim: 0xd0a24a, trousers: 0x23272b, sash: 0xd0a24a, wrap: 0xe3d9c6, shoe: 0x1d1d1f, hair: 0x141314, mask: 0xf3eee4, maskDark: 0x1a1416, accent: 0xb8352c },
    shape: { scale: 0.96, girth: 0.93, shoulder: 0.92, belly: 0.98, arm: 0.92, leg: 0.95, head: 0.98, hand: 0.92 },
    top: 'qipao', sleeves: 'short', hair: 'bun', apron: true, woklid: true,
    mask: { kind: 'opera', stripe: 'wings', slant: 14, brow: 0.01, ridge: 0.01 },
    flaps: { front: [0.28, 0.26], back: [0.28, 0.26], width: 0.24 }, tails: null,
  },
  brick: {
    pal: { skin: 0xb58262, top: 0xe1ddd3, top2: 0xd2cdc2, trim: 0xb3332a, trousers: 0x55585f, sash: 0x3a3c41, wrap: 0xd9d2c2, shoe: 0x222326, hair: 0x1c1917, mask: 0x8f8a82, maskDark: 0x161616, accent: 0xc63a2c },
    shape: { scale: 1.13, girth: 1.3, shoulder: 1.42, belly: 1.15, arm: 1.6, leg: 1.28, head: 0.95, hand: 1.3 },
    top: 'tank', sleeves: 'none', hair: 'short', headband: true,
    mask: { kind: 'brick', stripe: 'center', slant: 4, brow: 0.024, ridge: 0.004 },
    flaps: null, tails: [0.14, 0.12],
  },
  mr_golden: {
    pal: { skin: 0xd4ab88, top: 0xf0ece3, top2: 0xe2ddd2, trim: 0xd2a33a, trousers: 0xe8e3d9, sash: 0x1e1e22, wrap: 0xf0ece3, shoe: 0x1a1a1c, hair: 0x2a2420, mask: 0xe2b34c, maskDark: 0x2a1d08, accent: 0xe8b84f },
    shape: { scale: 1.01, girth: 1.02, shoulder: 1.06, belly: 1.04, arm: 1.0, leg: 1.0, head: 1.0, hand: 1.0 },
    top: 'suit', sleeves: 'long', hair: 'slick', tie: true,
    mask: { kind: 'golden', stripe: 'none', slant: 6, brow: 0.012, ridge: 0.014, metal: true },
    flaps: { front: [0.18], back: [0.26, 0.22], width: 0.22 }, tails: null,
  },
};

// mid-dark tops in hues clearly apart from skin, so costumes never read as bare skin (and never as black silhouettes)
const THUG_TOPS = [0x55657e, 0x6b6f45, 0x7a3b36, 0x3f6f6c, 0x8a6a2e, 0x664a66, 0x4a5260];
const THUG_TROUSERS = [0x696865, 0x63686f, 0x6d6861, 0x636a62];
const THUG_MASKS = [0xa79a84, 0x8c8172, 0x6e7378, 0xb9b09f, 0x7e6d5d];
const THUG_ACCENTS = [0xb5503c, 0xc9973c, 0x4b8fae, 0x8b9f4a, 0xa64a6a];
const THUG_HAIR = ['short', 'bald', 'cap', 'short', 'headband'];

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Resolve a look ({ preset, colors?, seed? }) into a full description used by the model builder. */
export function resolveLook(look = {}) {
  const preset = PRESETS[look.preset] ? look.preset : 'player';
  const d = clone(PRESETS[preset]);
  d.preset = preset;
  if (preset === 'thug') {
    const rng = makeRng((look.seed ?? 1) * 7919 + 13);
    d.pal.top = rng.pick(THUG_TOPS);
    d.pal.top2 = d.pal.top;
    d.pal.trousers = rng.pick(THUG_TROUSERS);
    d.pal.mask = rng.pick(THUG_MASKS);
    d.pal.accent = rng.pick(THUG_ACCENTS);
    d.pal.sash = d.pal.accent;
    const hair = rng.pick(THUG_HAIR);
    d.hair = hair === 'headband' ? 'short' : hair;
    d.headband = hair === 'headband' || rng.chance(0.25);
    d.sleeves = rng.chance(0.35) ? 'none' : 'short';
    d.top = d.sleeves === 'none' && rng.chance(0.5) ? 'vest' : 'tunic';
    d.mask.stripe = rng.pick(['seam', 'none', 'center', 'tear']);
    d.mask.slant = Math.round(rng.range(-4, 10));
    const k = rng.range(0.95, 1.12);
    d.shape.girth *= k; d.shape.belly *= rng.range(0.95, 1.15); d.shape.arm *= k;
    d.shape.scale = rng.range(0.96, 1.04);
    d.tails = rng.chance(0.5) ? [0.16, 0.14] : null;
  }
  if (look.colors) Object.assign(d.pal, look.colors);
  if (look.shape) Object.assign(d.shape, look.shape);
  d.key = JSON.stringify([preset, look.seed ?? 0, look.colors || null, look.shape || null]);
  return d;
}

export const LOOK_PRESETS = Object.keys(PRESETS);
