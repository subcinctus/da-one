// Inventory: 36 slots (0-8 hotbar, 9-35 backpack), hotbar selection, stacking, weapons + ammo, creative mode,
// save/load. See ARCHITECTURE.md §Inventory. Emits 'inventoryChanged' on any change and 'weaponChanged' when the
// selected item changes (slot switch or the content of the selected slot changing kind/id).
import { WEAPONS } from '../data/weapons.js';
import { BLOCKS } from '../world/blocks.js';
import {
  STACK_MAX, RESERVE_MAX, starterInventory, sanitizeItem, cloneItem, canStack, itemKey, itemName, isPlaceableBlock, isOreBlock,
} from '../data/items.js';

export const SLOT_COUNT = 36;
export const HOTBAR_SIZE = 9;

export class Inventory {
  constructor(game) {
    this.game = game;
    /** @type {Array<object|null>} */
    this.slots = new Array(SLOT_COUNT).fill(null);
    this.selected = 0;
    this.creative = false;
    /** blocks that did not fit during the last addBlock/addItem call */
    this.lastOverflow = 0;
    this._selKey = '';
    this._fullNotifyAt = -1e9;
    this._batch = 0;
    this._dirty = false;
  }

  init() {
    const start = starterInventory();
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = cloneItem(start[i] || null);
    this.selected = 0;
    this._selKey = itemKey(this.getSelected());
    this._emit();
  }

  // ------------------------------------------------------------------ queries

  /** Item in the selected hotbar slot (or null). */
  getSelected() { return this.slots[this.selected] || null; }

  /** The 9 hotbar slots (live references). */
  getHotbar() { return this.slots.slice(0, HOTBAR_SIZE); }

  /** Total number of blocks of `id` across all slots. */
  countBlock(id) {
    let n = 0;
    for (const it of this.slots) if (it && it.kind === 'block' && it.id === id) n += it.count;
    return n;
  }

  hasWeapon(id) { return this.findWeapon(id) >= 0; }

  hasTool(id) { return this.slots.some((it) => it && it.kind === 'tool' && it.id === id); }

  /** Slot index holding weapon `id`, or -1. */
  findWeapon(id) {
    for (let i = 0; i < SLOT_COUNT; i++) { const it = this.slots[i]; if (it && it.kind === 'weapon' && it.id === id) return i; }
    return -1;
  }

  /** Weapon item `id` (live reference) or null. */
  getWeapon(id) { const i = this.findWeapon(id); return i >= 0 ? this.slots[i] : null; }

  /** All weapon items (live references), hotbar first. */
  getWeapons() { return this.slots.filter((it) => it && it.kind === 'weapon'); }

  /** First empty slot index (hotbar first, then backpack) or -1. */
  firstEmpty(from = 0, to = SLOT_COUNT) {
    for (let i = from; i < to; i++) if (!this.slots[i]) return i;
    return -1;
  }

  isFull() { return this.firstEmpty() < 0; }

  // ------------------------------------------------------------------ selection

  /** Select hotbar slot i (0-8). Emits weaponChanged when the held item changes. */
  select(i) {
    i = ((Math.floor(Number(i)) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (!Number.isFinite(i)) return;
    const changedSlot = i !== this.selected;
    this.selected = i;
    if (changedSlot) {
      this._selKey = itemKey(this.getSelected());
      this.game.events?.emit('weaponChanged', { item: this.getSelected(), slot: i });
      this._emit();
    }
  }

  /** Select the hotbar slot holding weapon `id` (moves it into the hotbar if it is in the backpack). */
  selectWeapon(id) {
    let i = this.findWeapon(id);
    if (i < 0) return false;
    if (i >= HOTBAR_SIZE) { this.swap(i, this.selected); i = this.selected; }
    this.select(i);
    return true;
  }

  /** Cycle to the next hotbar slot holding a weapon (dir +1/-1). Returns true if the selection changed. */
  cycleWeapon(dir = 1) {
    for (let k = 1; k <= HOTBAR_SIZE; k++) {
      const i = (((this.selected + dir * k) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
      const it = this.slots[i];
      if (it && it.kind === 'weapon') { if (i !== this.selected) { this.select(i); return true; } return false; }
    }
    return false;
  }

  // ------------------------------------------------------------------ adding / removing

  /** Add any item (merges block stacks, tops up weapons). Returns true if everything fit. */
  addItem(item) {
    const it = sanitizeItem(item);
    if (!it) return false;
    if (it.kind === 'block') return this.addBlock(it.id, it.count);
    if (it.kind === 'weapon') return this.addWeapon(it.id, it.mag + it.reserve, { mag: it.mag });
    const slot = this.firstEmpty();
    if (slot < 0) { this._notifyFull(); return false; }
    this.slots[slot] = it;
    this._changed();
    return true;
  }

  /**
   * Add n blocks of `id`: fills existing stacks (hotbar first), then empty slots (hotbar first).
   * Returns true when all n fit (the rest is discarded; see lastOverflow).
   */
  addBlock(id, n = 1) {
    n = Math.floor(n);
    this.lastOverflow = 0;
    if (!BLOCKS[id] || id === 0 || !(n > 0)) return false;
    if (isOreBlock(id)) return false; // ores are never items (they pay cash when mined, see data/items.js)
    let left = n;
    for (let i = 0; i < SLOT_COUNT && left > 0; i++) {
      const it = this.slots[i];
      if (it && it.kind === 'block' && it.id === id && it.count < STACK_MAX) {
        const k = Math.min(left, STACK_MAX - it.count);
        it.count += k; left -= k;
      }
    }
    for (let i = 0; i < SLOT_COUNT && left > 0; i++) {
      if (!this.slots[i]) {
        const k = Math.min(left, STACK_MAX);
        this.slots[i] = { kind: 'block', id, count: k };
        left -= k;
      }
    }
    this.lastOverflow = left;
    if (left < n) this._changed();
    if (left > 0) {
      if (this.creative) return true; // creative: nobody cares about a full backpack
      this._notifyFull();
      return false;
    }
    return true;
  }

  /**
   * Remove n blocks of `id` (backpack stacks first so the hotbar stays stocked). Creative: always succeeds, removes nothing.
   * Returns false (and removes nothing) if there are not enough.
   */
  removeBlock(id, n = 1) {
    n = Math.floor(n);
    if (!(n > 0)) return true;
    if (this.creative) return true;
    if (this.countBlock(id) < n) return false;
    let left = n;
    for (let i = SLOT_COUNT - 1; i >= 0 && left > 0; i--) {
      const it = this.slots[i];
      if (it && it.kind === 'block' && it.id === id) {
        const k = Math.min(left, it.count);
        it.count -= k; left -= k;
        if (it.count <= 0) this.slots[i] = null;
      }
    }
    this._changed();
    return true;
  }

  /**
   * Consume n from the selected block stack (placing). Creative: free. When the stack runs out it is refilled from a
   * backpack stack of the same block (quality-of-life). Returns false if the selected item is not a block stack.
   */
  consumeSelected(n = 1) {
    const it = this.getSelected();
    if (!it || it.kind !== 'block') return false;
    if (this.creative) return true;
    if (it.count < n) return false;
    it.count -= n;
    if (it.count <= 0) {
      this.slots[this.selected] = null;
      for (let i = SLOT_COUNT - 1; i >= HOTBAR_SIZE; i--) {
        const s = this.slots[i];
        if (s && s.kind === 'block' && s.id === it.id) { this.slots[this.selected] = s; this.slots[i] = null; break; }
      }
    }
    this._changed();
    return true;
  }

  /**
   * Add weapon `id` with `ammo` total rounds. New weapon: fills the magazine first, rest goes to reserve
   * (ammo defaults to 1 magazine + 2 spare). Already owned: tops up the reserve (adds or tops up reserve).
   * opts.mag: preferred loaded rounds for a new weapon. Returns false if there was no room.
   */
  addWeapon(id, ammo, opts = {}) {
    const def = WEAPONS[id];
    if (!def) return false;
    const magSize = def.mag || 0;
    if (ammo === undefined || ammo === null || !Number.isFinite(Number(ammo))) ammo = magSize * 3;
    ammo = Math.max(0, Math.floor(Number(ammo)));
    const existing = this.getWeapon(id);
    if (existing) {
      if (magSize > 0) existing.reserve = Math.min(RESERVE_MAX, (existing.reserve | 0) + ammo);
      this._changed();
      return true;
    }
    let slot = this.firstEmpty(0, HOTBAR_SIZE);
    if (slot < 0) slot = this.firstEmpty(HOTBAR_SIZE, SLOT_COUNT);
    if (slot < 0) { this._notifyFull(); return false; }
    let mag = 0, reserve = 0;
    if (magSize > 0) {
      mag = Math.min(magSize, opts.mag !== undefined ? Math.max(0, Math.floor(opts.mag)) : ammo, ammo);
      reserve = Math.min(RESERVE_MAX, ammo - mag);
    }
    this.slots[slot] = { kind: 'weapon', id, mag, reserve };
    this._changed();
    return true;
  }

  /** Add spare rounds to an owned weapon. Returns false if the weapon is not owned or uses no ammo. */
  addAmmo(weaponId, rounds) {
    const it = this.getWeapon(weaponId);
    const def = WEAPONS[weaponId];
    if (!it || !def || !(def.mag > 0)) return false;
    rounds = Math.max(0, Math.floor(Number(rounds) || 0));
    if (rounds === 0) return true;
    it.reserve = Math.min(RESERVE_MAX, (it.reserve | 0) + rounds);
    this._changed();
    return true;
  }

  /** Remove every weapon (BUSTED). Tools and blocks are kept. */
  clearWeapons() {
    let any = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const it = this.slots[i];
      if (it && it.kind === 'weapon') { this.slots[i] = null; any = true; }
    }
    if (!this.hasTool('pickaxe')) {
      const s = this.firstEmpty();
      if (s >= 0) { this.slots[s] = { kind: 'tool', id: 'pickaxe' }; any = true; }
    }
    if (any) this._changed();
  }

  /** Creative mode: infinite blocks + full block palette (HUD inventory). */
  setCreative(on) {
    on = !!on;
    if (this.creative === on) return;
    this.creative = on;
    if (on) {
      // make sure the hotbar holds something buildable
      if (!this.slots.slice(0, HOTBAR_SIZE).some((it) => it && it.kind === 'block')) {
        const s = this.firstEmpty(0, HOTBAR_SIZE);
        if (s >= 0) this.slots[s] = { kind: 'block', id: 13, count: STACK_MAX };
      }
    }
    if (!on && this.game.player && this.game.player.flying) this.game.player.flying = false;
    this._purgeOres();
    this._changed(true);
  }

  /** Creative palette: put a full stack of `blockId` in the selected slot (or select it if already in the hotbar). */
  giveCreativeStack(blockId, toSlot = null) {
    if (!isPlaceableBlock(blockId)) return false;
    const slot = toSlot !== null ? toSlot : this.selected;
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    this.slots[slot] = { kind: 'block', id: blockId, count: STACK_MAX };
    this._changed();
    return true;
  }

  /**
   * Pick-block (MMB). Selects a hotbar slot that already has `blockId`; else swaps it in from the backpack;
   * else in creative creates a stack in the selected slot (or an empty hotbar slot). Returns true on success.
   */
  pickBlock(blockId) {
    if (!BLOCKS[blockId] || blockId === 0) return false;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const it = this.slots[i];
      if (it && it.kind === 'block' && it.id === blockId) { this.select(i); return true; }
    }
    for (let i = HOTBAR_SIZE; i < SLOT_COUNT; i++) {
      const it = this.slots[i];
      if (it && it.kind === 'block' && it.id === blockId) {
        const target = this.slots[this.selected] ? this.firstEmpty(0, HOTBAR_SIZE) : this.selected;
        this.swap(i, target >= 0 ? target : this.selected);
        this.select(target >= 0 ? target : this.selected);
        return true;
      }
    }
    if (this.creative && isPlaceableBlock(blockId)) {
      const cur = this.getSelected();
      let target = this.selected;
      if (cur && cur.kind !== 'block') { const e = this.firstEmpty(0, HOTBAR_SIZE); if (e >= 0) target = e; }
      this.slots[target] = { kind: 'block', id: blockId, count: STACK_MAX };
      if (target !== this.selected) this.select(target); else this._changed();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ slot editing (inventory screen)

  /** Replace slot i (item is sanitised). */
  setSlot(i, item) {
    if (i < 0 || i >= SLOT_COUNT) return false;
    this.slots[i] = item ? sanitizeItem(item) : null;
    this._changed();
    return true;
  }

  /** Remove and return the item in slot i. */
  takeSlot(i) {
    if (i < 0 || i >= SLOT_COUNT) return null;
    const it = this.slots[i];
    this.slots[i] = null;
    if (it) this._changed();
    return it;
  }

  /** Swap two slots. */
  swap(a, b) {
    if (a === b || a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT) return;
    const t = this.slots[a]; this.slots[a] = this.slots[b]; this.slots[b] = t;
    this._changed();
  }

  /** Move slot `from` onto `to`: merges equal block stacks (overflow stays in `from`), otherwise swaps. */
  moveSlot(from, to) {
    if (from === to || from < 0 || to < 0 || from >= SLOT_COUNT || to >= SLOT_COUNT) return;
    const a = this.slots[from], b = this.slots[to];
    if (canStack(a, b)) {
      const k = Math.min(a.count, STACK_MAX - b.count);
      b.count += k; a.count -= k;
      if (a.count <= 0) this.slots[from] = null;
      this._changed();
    } else this.swap(from, to);
  }

  /** Split a block stack in half into the first empty slot. */
  splitSlot(i) {
    const it = this.slots[i];
    if (!it || it.kind !== 'block' || it.count < 2) return false;
    const e = this.firstEmpty();
    if (e < 0) return false;
    const half = Math.floor(it.count / 2);
    it.count -= half;
    this.slots[e] = { kind: 'block', id: it.id, count: half };
    this._changed();
    return true;
  }

  /** Sort the backpack (9-35): weapons, tools, then blocks by id; merges partial stacks. */
  sortBackpack() {
    const items = this.slots.slice(HOTBAR_SIZE).filter(Boolean);
    const merged = [];
    for (const it of items) {
      const last = merged.find((m) => canStack(m, it) && m.count < STACK_MAX);
      if (last) {
        const k = Math.min(it.count, STACK_MAX - last.count);
        last.count += k;
        if (it.count - k > 0) merged.push({ ...it, count: it.count - k });
      } else merged.push(it);
    }
    const order = { weapon: 0, tool: 1, block: 2 };
    merged.sort((a, b) => (order[a.kind] - order[b.kind]) || (a.kind === 'block' ? a.id - b.id : String(a.id).localeCompare(String(b.id))));
    for (let i = HOTBAR_SIZE; i < SLOT_COUNT; i++) this.slots[i] = merged[i - HOTBAR_SIZE] || null;
    this._changed();
  }

  /** Empty every slot. */
  clear() {
    this.slots.fill(null);
    this._changed(true);
  }

  /** Reset to the new-game starter inventory. */
  reset() {
    const start = starterInventory();
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = cloneItem(start[i] || null);
    this.selected = 0;
    this.creative = false;
    this._changed(true);
  }

  // ------------------------------------------------------------------ save / load

  serialize() {
    return {
      v: 1,
      slots: this.slots.map((it) => cloneItem(it)),
      selected: this.selected,
      creative: this.creative,
    };
  }

  deserialize(obj) {
    if (!obj) return false;
    const slots = Array.isArray(obj) ? obj : obj.slots;
    if (!Array.isArray(slots)) return false;
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = sanitizeItem(slots[i]);
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, Math.floor(Number(obj.selected) || 0)));
    this.creative = !!obj.creative;
    this._changed(true);
    return true;
  }

  // ------------------------------------------------------------------ per frame

  update() {
    const input = this.game.input;
    if (!input) return;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (input.pressed('slot' + (i + 1))) { this.select(i); break; }
    }
    const p = this.game.player;
    const onFoot = !(p && p.inVehicle);
    // scroll wheel: next/previous hotbar slot (on foot; the wheel is free for the camera in vehicles)
    if (input.wheel && onFoot && !(this.game.cameraRig && this.game.cameraRig.wantsWheel)) {
      this.select(this.selected + Math.sign(input.wheel));
    }
    // Q: quick-cycle weapons (GTA-style weapon wheel substitute)
    if (input.pressed('drop') && onFoot) this.cycleWeapon(1);
  }

  // ------------------------------------------------------------------ internals

  /** Tell listeners the contents changed after mutating an item in place (e.g. ammo, inventory screen edits). */
  notifyChanged() { this._purgeOres(); this._changed(); }

  /** Drop ore stacks (exploit leftovers / old saves / creative palette): ores are never inventory items. */
  _purgeOres() {
    let any = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const it = this.slots[i];
      if (it && it.kind === 'block' && isOreBlock(it.id)) { this.slots[i] = null; any = true; }
    }
    return any;
  }

  /** Run fn with change events coalesced into one. */
  batch(fn) {
    this._batch++;
    try { fn(); } finally {
      this._batch--;
      if (this._batch === 0 && this._dirty) { this._dirty = false; this._changed(); }
    }
  }

  _changed(forceWeaponEvent = false) {
    if (this._batch > 0) { this._dirty = true; return; }
    const key = itemKey(this.getSelected());
    if (key !== this._selKey || forceWeaponEvent) {
      this._selKey = key;
      this.game.events?.emit('weaponChanged', { item: this.getSelected(), slot: this.selected });
    }
    this._emit();
  }

  _emit() { this.game.events?.emit('inventoryChanged', {}); }

  _notifyFull() {
    const now = this.game.realTime || 0;
    if (now - this._fullNotifyAt < 3) return;
    this._fullNotifyAt = now;
    this.game.hud?.notify?.('Inventory full', { color: '#e5484d', duration: 2 });
  }

  /** Human-readable summary (debug). */
  describe() {
    return this.slots.map((it, i) => (it ? `${i}:${itemName(it)}${it.kind === 'block' ? ' x' + it.count : it.kind === 'weapon' ? ` ${it.mag}/${it.reserve}` : ''}` : null)).filter(Boolean);
  }
}

