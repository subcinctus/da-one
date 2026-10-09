// Inventory item model. Owned by the PLAYER agent (may extend; never rename fields).
//
// An inventory slot holds null or an ITEM object:
//   { kind: 'block',  id: <block id number>, count: <1..64> }
//   { kind: 'weapon', id: <weapon id string from data/weapons.js>, mag: <rounds loaded>, reserve: <spare rounds> }
//   { kind: 'tool',   id: 'pickaxe' | 'axe' | 'shovel' }
import { WEAPONS } from './weapons.js';
import { BLOCKS } from '../world/blocks.js';

export const STACK_MAX = 64;

export const TOOLS = {
  pickaxe: { id: 'pickaxe', name: 'Pickaxe', tool: 'pickaxe', damage: 18, icon: '⛏️' },
  axe:     { id: 'axe', name: 'Axe', tool: 'axe', damage: 24, icon: '🪓' },
  shovel:  { id: 'shovel', name: 'Shovel', tool: 'shovel', damage: 14, icon: '🪏' },
};

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

/** Starting inventory for a new game (hotbar = first 9 slots). */
export function starterInventory() {
  return [
    toolItem('pickaxe'),
    weaponItem('pistol', 12, 36),
    blockItem(13, 32),  // concrete
    blockItem(10, 32),  // planks
    blockItem(18, 16),  // glass
    blockItem(27, 4),   // TNT
    null, null, null,
  ];
}
