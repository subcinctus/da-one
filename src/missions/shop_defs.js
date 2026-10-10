// Shop catalogues + prices (pure data; node-testable). Used by shops.js / shop_ui.js.
import { B, BLOCKS } from '../world/blocks.js';
import { WEAPONS, SHOP_WEAPONS } from '../data/weapons.js';
import { TOOLS } from '../data/items.js';

/** Shop POI types and their look. color = in-world marker colour; blip = minimap colour (matches the full map). */
export const SHOP_TYPES = {
  gunshop: { name: 'Ammu-Blocks', color: '#e5484d', blip: '#ef6c00', icon: 'gun', blipIcon: 'gun', vehicle: false },
  hardware: { name: 'Block Depot', color: '#f59e0b', blip: '#f9a825', icon: 'cart', blipIcon: 'shop', vehicle: false },
  hospital: { name: 'Hospital', color: '#ffffff', blip: '#e53935', icon: 'cross', blipIcon: 'hospital', vehicle: false },
  garage: { name: 'Pay\'n\'Spray', color: '#46c46f', blip: '#00acc1', icon: 'spray', blipIcon: 'garage', vehicle: true },
  safehouse: { name: 'Safehouse', color: '#3fa9ff', blip: '#43a047', icon: 'home', blipIcon: 'home', vehicle: false },
};

export const ARMOR_PRICE = 200;
export const HEAL_PRICE = 50;
export const RESPRAY_PRICE = 250;
export const BULK_DISCOUNT = 0.9; // 64-stacks cost 10% less per block

/** Paint jobs offered by the Pay'n'Spray. */
export const RESPRAY_COLORS = [
  { name: 'Signal Red', hex: 0xd62f2f },
  { name: 'Sunburst Orange', hex: 0xf07b1d },
  { name: 'Taxi Yellow', hex: 0xf3c623 },
  { name: 'Lime', hex: 0x6fc53a },
  { name: 'Racing Green', hex: 0x1f6b3a },
  { name: 'Teal', hex: 0x1fa7a0 },
  { name: 'Sky Blue', hex: 0x3f9fe6 },
  { name: 'Midnight Blue', hex: 0x1d2f6b },
  { name: 'Royal Purple', hex: 0x7a3fc4 },
  { name: 'Hot Pink', hex: 0xe8459a },
  { name: 'Pearl White', hex: 0xeef0f2 },
  { name: 'Graphite', hex: 0x3a3d44 },
  { name: 'Matte Black', hex: 0x15161a },
  { name: 'Champagne Gold', hex: 0xc9a85a },
];

/** Hardware store catalogue: categories of {id, price (per block)}. */
export function hardwareCatalog() {
  const cat = (name, list) => ({ name, items: list.filter(([k]) => B[k] !== undefined && BLOCKS[B[k]]).map(([k, price]) => ({ id: B[k], price })) });
  return [
    cat('Building', [
      ['PLANKS', 1], ['COBBLESTONE', 1], ['BRICK', 2], ['CONCRETE', 2], ['CONCRETE_DARK', 2], ['SANDSTONE', 2],
      ['PLASTER', 2], ['STUCCO_PINK', 2], ['STUCCO_TEAL', 2], ['TERRACOTTA', 2], ['TILE_WHITE', 2], ['ROOF', 2],
      ['GLASS', 2], ['WINDOW', 3], ['MARBLE', 4], ['METAL', 4],
    ]),
    cat('Nature', [
      ['DIRT', 1], ['GRASS', 1], ['SAND', 1], ['GRAVEL', 1], ['SNOW', 1], ['LOG', 1], ['PALM_LOG', 1], ['LEAVES', 1],
      ['PALM_LEAVES', 1], ['HEDGE', 2], ['TALL_GRASS', 1], ['FLOWER_RED', 1], ['FLOWER_YELLOW', 1],
    ]),
    cat('Decor', [
      ['WOOL_WHITE', 2], ['WOOL_BLACK', 2], ['WOOL_RED', 2], ['WOOL_ORANGE', 2], ['WOOL_YELLOW', 2], ['WOOL_GREEN', 2],
      ['WOOL_BLUE', 2], ['WOOL_PURPLE', 2], ['CARPET_RED', 2], ['BOOKSHELF', 4], ['CRATE', 2], ['HAZARD', 3],
      ['LAMP', 4], ['WINDOW_LIT', 4], ['NEON_PINK', 5], ['NEON_BLUE', 5], ['SOLAR', 5],
    ]),
  ];
}

/** TNT packs (price per pack). */
export const TNT_PACKS = [
  { count: 4, price: 120 },
  { count: 16, price: 420 },
];

/** Tools for sale. */
export const TOOL_PRICES = { pickaxe: 100, axe: 120, shovel: 80 };
export const TOOL_LIST = Object.keys(TOOL_PRICES).filter((k) => TOOLS[k]);

/** Price of a stack of n blocks at `unit` $/block (bulk discount on full stacks). */
export function stackPrice(unit, n) {
  const raw = unit * n;
  return Math.max(1, Math.round(n >= 64 ? raw * BULK_DISCOUNT : raw));
}

/** Weapons for sale, in display order. */
export function gunCatalog() {
  return SHOP_WEAPONS.filter((id) => WEAPONS[id]).map((id) => {
    const w = WEAPONS[id];
    return { id, name: w.name, price: w.price || 0, ammo: ammoPack(id), stats: weaponStats(id), kind: w.kind };
  });
}

/** Ammo refill for a weapon: {rounds, price} or null (melee). Grenades count as ammo (3 per pack). */
export function ammoPack(id) {
  const w = WEAPONS[id];
  if (!w || !(w.mag > 0)) return null;
  let rounds = w.mag * 2;
  if (w.kind === 'throw') rounds = 3;
  else if (w.kind === 'projectile') rounds = 2;
  return { rounds, price: w.ammoPrice || Math.round((w.price || 100) * 0.1) };
}

/** Rounds given with a freshly bought weapon (a full magazine + spare). */
export function purchaseRounds(id) {
  const w = WEAPONS[id];
  if (!w || !(w.mag > 0)) return 0;
  if (w.kind === 'throw') return 3;
  if (w.kind === 'projectile') return 3;
  return w.mag * 3;
}

/** 0..1 stat bars for the gun shop cards. */
export function weaponStats(id) {
  const w = WEAPONS[id] || {};
  const c01 = (v) => Math.max(0.04, Math.min(1, v));
  const dmg = (w.damage || 0) * (w.pellets || 1);
  return {
    damage: c01(w.blastRadius ? 1 : dmg / 140),
    rate: c01((w.rate || 0) / 13),
    range: c01((w.range || 0) / 400),
    accuracy: w.kind === 'melee' ? 1 : c01(1 - (w.spread || 0) / 0.09),
  };
}
