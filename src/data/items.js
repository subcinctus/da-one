// Inventory item model. Owned by the PLAYER agent (may extend; never rename fields).
//
// An inventory slot holds null or an ITEM object:
//   { kind: 'block',  id: <block id number>, count: <1..64> }
//   { kind: 'weapon', id: <weapon id string from data/weapons.js>, mag: <rounds loaded>, reserve: <spare rounds> }
//   { kind: 'tool',   id: 'pickaxe' | 'axe' | 'shovel' }
//
// Pure data + helpers only (no DOM / THREE): importable from Node for unit tests.
import { WEAPONS } from './weapons.js';
import { BLOCKS, B } from '../world/blocks.js';

export const STACK_MAX = 64;
/** Max spare rounds a weapon can carry (keeps the HUD tidy and pickups meaningful). */
export const RESERVE_MAX = 999;

export const TOOLS = {
  pickaxe: { id: 'pickaxe', name: 'Pickaxe', tool: 'pickaxe', damage: 18, icon: '⛏️', color: 0x8f969c },
  axe:     { id: 'axe', name: 'Axe', tool: 'axe', damage: 24, icon: '🪓', color: 0x9aa1a6 },
  shovel:  { id: 'shovel', name: 'Shovel', tool: 'shovel', damage: 14, icon: '🪏', color: 0xa3aab0 },
};

/** Fist damage (also used for block items held in the hand). */
export const FIST_DAMAGE = (WEAPONS.fist && WEAPONS.fist.damage) || 12;

export const blockItem = (id, count = 1) => ({ kind: 'block', id, count });
export const weaponItem = (id, mag = WEAPONS[id] ? WEAPONS[id].mag : 0, reserve = 0) => ({ kind: 'weapon', id, mag, reserve });
export const toolItem = (id) => ({ kind: 'tool', id });

export function itemName(item) {
  if (!item) return '';
  if (item.kind === 'block') return (BLOCKS[item.id] && BLOCKS[item.id].name) || 'Block';
  if (item.kind === 'weapon') return (WEAPONS[item.id] && WEAPONS[item.id].name) || item.id;
  if (item.kind === 'tool') return (TOOLS[item.id] && TOOLS[item.id].name) || item.id;
  return '?';
}

/** Max stack size of an item (blocks stack to 64, weapons/tools do not stack). */
export function maxStack(item) {
  return item && item.kind === 'block' ? STACK_MAX : 1;
}

/** Short emoji icon for weapons/tools (HUD hotbar). Blocks return null: use world.textures.getIcon(id). */
export function itemIcon(item) {
  if (!item) return null;
  if (item.kind === 'weapon') return (WEAPONS[item.id] && WEAPONS[item.id].icon) || '🔫';
  if (item.kind === 'tool') return (TOOLS[item.id] && TOOLS[item.id].icon) || '🔧';
  return null;
}

/** Stable key identifying "what" an item is (ignores counts/ammo): 'block:13', 'weapon:pistol', 'tool:axe'. */
export function itemKey(item) {
  return item ? item.kind + ':' + item.id : '';
}

/** Deep copy of an item (items are plain objects). */
export function cloneItem(item) {
  return item ? { ...item } : null;
}

/** True when b can merge into a's stack. */
export function canStack(a, b) {
  return !!(a && b && a.kind === 'block' && b.kind === 'block' && a.id === b.id);
}

/** Mining tool type of an item ('pickaxe'|'axe'|'shovel') or null (hand, block, weapon). */
export function toolOf(item) {
  if (!item || item.kind !== 'tool') return null;
  return (TOOLS[item.id] && TOOLS[item.id].tool) || null;
}

/** Punch damage dealt when swinging with this item selected (empty hand / block = fists). */
export function meleeDamage(item) {
  if (item && item.kind === 'tool' && TOOLS[item.id]) return TOOLS[item.id].damage;
  if (item && item.kind === 'weapon' && WEAPONS[item.id] && WEAPONS[item.id].kind === 'melee') return WEAPONS[item.id].damage;
  return FIST_DAMAGE;
}

/** Total rounds (mag + reserve) of a weapon item. */
export const totalAmmo = (item) => (item && item.kind === 'weapon' ? (item.mag | 0) + (item.reserve | 0) : 0);

/** Weapons that use ammunition (mag > 0 in their definition). */
export const usesAmmo = (weaponId) => !!(WEAPONS[weaponId] && WEAPONS[weaponId].mag > 0);

/**
 * True for blocks that pay cash when mined (ores). Ores are never inventory items: they pay only when naturally
 * generated, cannot be placed and are never handed out as (creative) stacks, so no place-and-mine money loop exists.
 */
export function isOreBlock(id) {
  const d = BLOCKS[id];
  return !!(d && d.value > 0);
}

/** True if a block id can be held / placed (never ores, see isOreBlock). */
export function isPlaceableBlock(id) {
  const d = BLOCKS[id];
  return !!(d && d.id !== 0 && d.placeable !== false && !(d.value > 0));
}

/**
 * Validate + normalise an item coming from storage or another module. Returns a clean item or null.
 * Accepts block ids as numbers or keys ('CONCRETE').
 */
export function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'block') {
    let id = raw.id;
    if (typeof id === 'string') id = B[id] !== undefined ? B[id] : parseInt(id, 10);
    if (!Number.isInteger(id) || !BLOCKS[id] || id === 0 || isOreBlock(id)) return null;
    const count = Math.max(0, Math.min(STACK_MAX, Math.floor(Number(raw.count) || 0)));
    return count > 0 ? { kind: 'block', id, count } : null;
  }
  if (raw.kind === 'weapon') {
    const def = WEAPONS[raw.id];
    if (!def) return null;
    const mag = Math.max(0, Math.min(def.mag || 0, Math.floor(Number(raw.mag) || 0)));
    const reserve = Math.max(0, Math.min(RESERVE_MAX, Math.floor(Number(raw.reserve) || 0)));
    return { kind: 'weapon', id: raw.id, mag, reserve };
  }
  if (raw.kind === 'tool') {
    return TOOLS[raw.id] ? { kind: 'tool', id: raw.id } : null;
  }
  return null;
}

/** Starting inventory for a new game (hotbar = first 9 slots). */
export function starterInventory() {
  return [
    toolItem('pickaxe'),
    weaponItem('pistol', 12, 36),
    blockItem(B.CONCRETE, 32),
    blockItem(B.PLANKS, 32),
    blockItem(B.GLASS, 16),
    blockItem(B.TNT, 4),
    blockItem(B.BRICK, 32),
    null, null,
  ];
}
