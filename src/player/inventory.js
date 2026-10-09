// STUB - to be replaced by the PLAYER agent. See ARCHITECTURE.md §Inventory.
import { starterInventory } from '../data/items.js';
export class Inventory {
  constructor(game) { this.game = game; this.slots = new Array(36).fill(null); this.selected = 0; this.creative = false; }
  init() { starterInventory().forEach((it, i) => { this.slots[i] = it; }); }
  getSelected() { return this.slots[this.selected]; }
  select(i) { this.selected = i; }
  addItem() { return true; } addBlock() { return true; } removeBlock() { return true; } countBlock() { return 0; }
  addWeapon() {} addAmmo() {} hasWeapon() { return false; } clearWeapons() {} setCreative(v) { this.creative = v; }
  serialize() { return { slots: this.slots, selected: this.selected, creative: this.creative }; }
  deserialize() {}
  update() {}
}
