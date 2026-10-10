// Inventory screen (action `inventory`, E; game.openUI('inventory')): a Minecraft-style container with the 27
// backpack + 9 hotbar slots, click to pick up / place / swap / merge stacks, right-click to split or place one,
// shift-click quick-move, number keys over a slot swap it with that hotbar slot, tooltips with item stats,
// a creative palette of every placeable block (+ search and a trash slot), a Creative-mode toggle and player stats.
import { el } from './styles.js';
import { setIcon, STAR_SVG } from './icons.js';
import { formatMoney, formatClock, escapeHtml } from './format.js';
import { BLOCKS, PLACEABLE_BLOCKS } from '../world/blocks.js';
import { WEAPONS } from '../data/weapons.js';
import { TOOLS, itemName, canStack, cloneItem, itemKey, STACK_MAX } from '../data/items.js';

const HOT = 9;
const SLOTS = 36;
const LONG_PRESS = 0.42;

const sig = (it) => (it ? it.kind + ':' + it.id + ':' + (it.count | 0) + ':' + (it.mag | 0) + ':' + (it.reserve | 0) : '');

export class InventoryScreen {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.isOpen = false;
    this.root = null;
    this.held = null;
    this.heldFrom = -1;
    this.hover = -1;
    this.slotEls = new Array(SLOTS).fill(null);
    this._sigs = new Array(SLOTS).fill(null);
    this._sel = -1;
    this._statsT = 0;
    this._creative = null;
    this._mx = 0; this._my = 0;
    this._press = null;
    this._onMove = (e) => this._pointerMove(e);
  }

  get inv() { return this.game.inventory || null; }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    if (this.isOpen) return;
    const inv = this.inv;
    if (!inv || !Array.isArray(inv.slots)) { this.hud.notify('Inventory unavailable'); return; }
    this.isOpen = true;
    this.game.openUI('inventory');
    this.game.audio?.play?.('ui_open');
    this._build();
    window.addEventListener('pointermove', this._onMove);
    this.render(true);
  }

  close() {
    if (!this.isOpen) return;
    this._returnHeld();
    this.isOpen = false;
    window.removeEventListener('pointermove', this._onMove);
    if (this.root) { this.root.remove(); this.root = null; }
    this.slotEls.fill(null);
    this._sigs.fill(null);
    this.hover = -1;
    this.game.closeUI('inventory');
  }

  // ---------------------------------------------------------------- DOM

  _build() {
    const layer = el('div', 'bc-layer', this.hud.layerRoot);
    this.root = layer;
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    layer.addEventListener('mousedown', (e) => e.stopPropagation());
    layer.addEventListener('pointerdown', (e) => {
      // click on empty space returns the held stack
      if (!e.target.closest('.bc-islot') && !e.target.closest('.bc-toggle, input, button') && this.held) {
        this._returnHeld(); this._commit();
      }
    });
    const box = el('div', 'bc-inv', layer);
    this.box = box;
    const main = el('div', 'col main', box);
    const h = el('h3', '', main);
    el('span', '', h, 'Inventory');
    el('span', 'sp', h);
    this.modeTag = el('span', '', h);
    this.modeTag.style.cssText = 'font-size:12px;color:#555';
    this.palBox = el('div', 'bc-pal', main);
    this.backGrid = el('div', 'bc-grid', main);
    for (let i = HOT; i < SLOTS; i++) this.slotEls[i] = this._slotEl(this.backGrid, i);
    this.hotGrid = el('div', 'bc-grid hot', main);
    for (let i = 0; i < HOT; i++) this.slotEls[i] = this._slotEl(this.hotGrid, i);
    const help = el('div', 'help', main);
    help.innerHTML = this.hud.touchMode
      ? 'Tap a stack to pick it up, tap a slot to drop it. Long-press to split a stack.'
      : '<b>Click</b> pick up / place · <b>Right-click</b> split / place one · <b>Shift-click</b> quick move · <b>1-9</b> over a slot: move to hotbar';

    const side = el('div', 'side', box);
    this.side = side;
    this.stats = el('div', 'bc-stats', side);
    this._buildStats();
    this.creativeToggle = el('div', 'bc-toggle', side);
    el('span', '', this.creativeToggle, 'Creative mode');
    el('span', 'sw', this.creativeToggle);
    this.creativeToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const inv = this.inv;
      if (!inv) return;
      const on = !inv.creative;
      if (typeof inv.setCreative === 'function') inv.setCreative(on); else inv.creative = on;
      this.game.audio?.play?.('ui_click');
      this.hud.notify(on ? 'Creative mode *ON*: unlimited blocks, double-tap [Space] to fly' : 'Creative mode OFF', { duration: 3 });
      this.render(true);
    });

    const x = el('button', 'bc-x bc-inv-close', box, '✕');
    x.title = 'Close (E / Esc)';
    x.addEventListener('click', (e) => { e.stopPropagation(); this.game.audio?.play?.('ui_click'); this.close(); });

    this.cursor = el('div', 'bc-cursor', layer);
    this.cursorIco = el('div', 'ico', this.cursor);
    this.cursorCnt = el('span', 'cnt', this.cursor);
    this.tipBox = el('div', 'bc-tipbox', layer);

    box.addEventListener('pointerdown', (e) => this._pointerDown(e));
    box.addEventListener('pointerup', () => {
      const pr = this._press;
      this._press = null;
      if (pr && !pr.done) { pr.done = true; this._click(pr.i, false, false); }
    });
    box.addEventListener('pointercancel', () => { this._press = null; });
    box.addEventListener('pointerover', (e) => {
      const s = e.target.closest('.bc-islot');
      if (!s) return;
      const i = s.dataset.i !== undefined ? +s.dataset.i : -1;
      this.hover = i;
      this._showTip(i >= 0 ? this.inv.slots[i] : (s.dataset.b !== undefined ? { kind: 'block', id: +s.dataset.b, count: STACK_MAX, palette: true } : null));
    });
    box.addEventListener('pointerout', (e) => {
      const s = e.target.closest('.bc-islot');
      if (s && !s.contains(e.relatedTarget)) { this.hover = -1; this._showTip(null); }
    });
  }

  _slotEl(parent, i) {
    const s = el('div', 'bc-islot', parent);
    s.dataset.i = String(i);
    el('div', 'ico', s);
    el('span', 'cnt', s);
    return s;
  }

  _buildStats() {
    const s = this.stats;
    s.innerHTML = '';
    const row = (k, cls) => { el('span', 'k', s, k); return el('span', 'v' + (cls ? ' ' + cls : ''), s); };
    this.stHp = row('Health');
    this.stHpBar = el('div', 'bc-mbar', s); el('i', '', this.stHpBar);
    this.stAr = row('Armor');
    this.stArBar = el('div', 'bc-mbar ar', s); el('i', '', this.stArBar);
    this.stMoney = row('Cash', 'money');
    this.stWanted = row('Wanted');
    this.stWanted.innerHTML = '<span class="stars">' + Array(5).fill('<span class="bc-star">' + STAR_SVG + '</span>').join('') + '</span>';
    this.stTime = row('Time');
    this.stArea = row('Area');
  }

  _updateStats() {
    const g = this.game;
    const p = g.player;
    const hp = p ? Math.max(0, Math.round(p.health || 0)) : 0;
    const ar = p ? Math.max(0, Math.round(p.armor || 0)) : 0;
    this.stHp.textContent = hp + ' / ' + (p?.maxHealth || 100);
    this.stHpBar.firstChild.style.transform = `scaleX(${Math.min(1, hp / (p?.maxHealth || 100))})`;
    this.stAr.textContent = ar + ' / ' + (p?.maxArmor || 100);
    this.stArBar.firstChild.style.transform = `scaleX(${Math.min(1, ar / (p?.maxArmor || 100))})`;
    this.stMoney.textContent = formatMoney(p?.money || 0);
    const w = (g.police?.wanted) | 0;
    const stars = this.stWanted.querySelectorAll('.bc-star');
    stars.forEach((st, i) => st.classList.toggle('on', i < w));
    this.stTime.textContent = g.sky ? formatClock(g.sky.time) : '--:--';
    let area = '';
    try { area = p && g.generator?.plan?.districtAt ? (g.generator.plan.districtAt(p.position.x, p.position.z)?.name || '') : ''; } catch (e) { area = ''; }
    this.stArea.textContent = area || '-';
  }

  _buildPalette() {
    const box = this.palBox;
    box.innerHTML = '';
    const inv = this.inv;
    if (!inv || !inv.creative) { box.style.display = 'none'; return; }
    box.style.display = '';
    const h = el('div', 'bar', box);
    el('span', 'lbl', h, 'Blocks');
    const search = el('input', '', h);
    search.type = 'text';
    search.placeholder = 'Search...';
    const trash = el('div', 'bc-islot trash', h);
    trash.dataset.trash = '1';
    trash.title = 'Destroy item (drop a stack here)';
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.blur(); e.stopPropagation(); } });
    const scroll = el('div', 'bc-scroll', box);
    const grid = el('div', 'bc-grid', scroll);
    const items = [];
    for (const id of PLACEABLE_BLOCKS) {
      const def = BLOCKS[id];
      if (!def) continue;
      const s = el('div', 'bc-islot', grid);
      s.dataset.b = String(id);
      const ico = el('div', 'ico', s);
      setIcon(ico, { kind: 'block', id }, this.game.world);
      items.push({ s, name: def.name.toLowerCase() });
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const it of items) it.s.style.display = !q || it.name.includes(q) ? '' : 'none';
    });
  }

  /** Sync slot elements with inventory.slots (only changed slots are touched). */
  render(full = false) {
    const inv = this.inv;
    if (!inv || !this.root) return;
    const creative = !!inv.creative;
    if (creative !== this._creative || full) {
      this._creative = creative;
      this.creativeToggle.classList.toggle('on', creative);
      this.modeTag.textContent = creative ? 'CREATIVE' : 'SURVIVAL';
      this._buildPalette();
    }
    const world = this.game.world;
    for (let i = 0; i < SLOTS; i++) {
      const it = inv.slots[i] || null;
      const s = sig(it) + (creative ? 'c' : '');
      const se = this.slotEls[i];
      if (!se) continue;
      if (s !== this._sigs[i] || full) {
        this._sigs[i] = s;
        setIcon(se.firstChild, it, world);
        const cnt = se.lastChild;
        let txt = '', cls = 'cnt';
        if (it && it.kind === 'block' && it.count > 1) txt = String(it.count);
        else if (it && it.kind === 'weapon' && WEAPONS[it.id] && WEAPONS[it.id].mag > 0) {
          txt = String((it.mag | 0) + (it.reserve | 0)); // same total as the HUD hotbar (tooltip: mag / reserve)
          cls = 'cnt ammo' + ((it.mag | 0) + (it.reserve | 0) === 0 ? ' zero' : '');
        }
        cnt.textContent = txt;
        cnt.className = cls;
      }
    }
    const sel = inv.selected | 0;
    if (sel !== this._sel || full) {
      if (this._sel >= 0 && this.slotEls[this._sel]) this.slotEls[this._sel].classList.remove('sel');
      this._sel = sel;
      if (this.slotEls[sel]) this.slotEls[sel].classList.add('sel');
    }
    this._renderCursor();
  }

  _renderCursor() {
    const h = this.held;
    this.cursor.classList.toggle('on', !!h);
    if (!h) return;
    setIcon(this.cursorIco, h, this.game.world);
    this.cursorCnt.textContent = h.kind === 'block' && h.count > 1 ? String(h.count) : '';
    this.cursor.style.left = this._mx + 'px';
    this.cursor.style.top = this._my + 'px';
  }

  _showTip(item) {
    const tb = this.tipBox;
    if (!tb) return;
    if (!item || this.held) { tb.classList.remove('on'); return; }
    let html = '<div class="t">' + escapeHtml(itemName(item)) + '</div>';
    if (item.kind === 'block') {
      const def = BLOCKS[item.id] || {};
      html += '<div class="d">Block' + (item.palette ? ' · click for a stack of 64' : ' · ' + (item.count | 0) + ' / ' + STACK_MAX) + '</div>';
      if (def.tool) html += '<div class="d">Best tool: ' + def.tool + '</div>';
      if (def.explosive) html += '<div class="v">Explosive! Shoot it or blow it up.</div>';
      if (def.value > 0) html += '<div class="v">Worth $' + def.value + ' when mined</div>';
      if (def.emissive) html += '<div class="d">Glows at night</div>';
    } else if (item.kind === 'weapon') {
      const w = WEAPONS[item.id] || {};
      const kind = { melee: 'Melee', hitscan: 'Firearm', projectile: 'Launcher', throw: 'Throwable' }[w.kind] || 'Weapon';
      html += '<div class="d">' + kind + ' · Damage ' + (w.damage || 0) + (w.pellets ? ' x' + w.pellets : '') + (w.rate ? ' · ' + w.rate + '/s' : '') + '</div>';
      if (w.mag > 0) html += '<div class="w">Ammo ' + (item.mag | 0) + ' / ' + (item.reserve | 0) + '</div>';
      if (w.auto) html += '<div class="d">Automatic</div>';
    } else if (item.kind === 'tool') {
      const t = TOOLS[item.id] || {};
      html += '<div class="d">Tool · Damage ' + (t.damage || 0) + '</div>';
      const good = { pickaxe: 'stone, ores, concrete', axe: 'wood, planks, crates', shovel: 'dirt, sand, gravel' }[t.tool];
      if (good) html += '<div class="d">Fast on ' + good + '</div>';
    }
    tb.innerHTML = html;
    tb.classList.add('on');
    this._placeTip();
  }

  _placeTip() {
    const tb = this.tipBox;
    if (!tb || !tb.classList.contains('on')) return;
    const W = window.innerWidth;
    let x = this._mx + 16, y = this._my - 12;
    const w = tb.offsetWidth || 200;
    if (x + w > W - 8) x = this._mx - w - 16;
    tb.style.left = Math.max(4, x) + 'px';
    tb.style.top = Math.max(4, y) + 'px';
  }

  // ---------------------------------------------------------------- interaction

  _pointerMove(e) {
    this._mx = e.clientX; this._my = e.clientY;
    if (this.held) { this.cursor.style.left = this._mx + 'px'; this.cursor.style.top = this._my + 'px'; }
    this._placeTip();
  }

  _pointerDown(e) {
    this._mx = e.clientX; this._my = e.clientY;
    const s = e.target.closest('.bc-islot');
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    const right = e.button === 2;
    const shift = e.shiftKey;
    if (s.dataset.trash) { if (this.held) { this.held = null; this.heldFrom = -1; this.game.audio?.play?.('block_break', { volume: 0.4 }); this._commit(); } return; }
    if (s.dataset.b !== undefined) { this._palette(+s.dataset.b, right, shift); return; }
    const i = +s.dataset.i;
    if (!(i >= 0 && i < SLOTS)) return;
    if (e.pointerType === 'touch' && !right) {
      // tap = click, long-press = right click (split a stack / place one)
      const press = { i, done: false };
      this._press = press;
      setTimeout(() => {
        if (this._press === press && !press.done && this.isOpen) { press.done = true; this._click(i, true, false); }
      }, LONG_PRESS * 1000);
      return;
    }
    this._click(i, right, shift);
  }

  _click(i, right, shift) {
    const inv = this.inv;
    const slots = inv.slots;
    const cur = slots[i];
    let changed = false;
    if (shift && !this.held && cur) {
      changed = this._quickMove(i);
    } else if (!this.held) {
      if (!cur) return;
      if (right && cur.kind === 'block' && cur.count > 1) {
        const take = Math.ceil(cur.count / 2);
        this.held = { kind: 'block', id: cur.id, count: take };
        cur.count -= take;
      } else {
        this.held = cur;
        slots[i] = null;
      }
      this.heldFrom = i;
      changed = true;
    } else {
      const h = this.held;
      if (right && h.kind === 'block') {
        if (!cur) { slots[i] = { kind: 'block', id: h.id, count: 1 }; h.count--; changed = true; }
        else if (canStack(cur, h) && cur.count < STACK_MAX) { cur.count++; h.count--; changed = true; }
        if (h.count <= 0) this.held = null;
      } else if (!cur) {
        slots[i] = h; this.held = null; changed = true;
      } else if (canStack(cur, h)) {
        const k = Math.min(h.count, STACK_MAX - cur.count);
        if (k > 0) { cur.count += k; h.count -= k; changed = true; }
        if (h.count <= 0) this.held = null;
        else if (k === 0) { slots[i] = h; this.held = cur; changed = true; }
      } else {
        slots[i] = h; this.held = cur; this.heldFrom = i; changed = true;
      }
    }
    if (changed) {
      this.game.audio?.play?.('ui_click', { volume: 0.6 });
      this._commit();
    }
    this._showTip(this.held ? null : slots[i]);
  }

  /** Shift-click: hotbar <-> backpack. */
  _quickMove(i) {
    const slots = this.inv.slots;
    const it = slots[i];
    if (!it) return false;
    const [a, b] = i < HOT ? [HOT, SLOTS] : [0, HOT];
    // merge into existing stacks first
    if (it.kind === 'block') {
      for (let j = a; j < b && it.count > 0; j++) {
        const t = slots[j];
        if (canStack(t, it) && t.count < STACK_MAX) { const k = Math.min(it.count, STACK_MAX - t.count); t.count += k; it.count -= k; }
      }
      if (it.count <= 0) { slots[i] = null; return true; }
    }
    for (let j = a; j < b; j++) {
      if (!slots[j]) { slots[j] = it; slots[i] = null; return true; }
    }
    return it.kind === 'block';
  }

  _palette(id, right, shift) {
    const inv = this.inv;
    if (!inv || !inv.creative) return;
    if (shift && !this.held) {
      // straight into the hotbar: an existing stack of it, else an empty slot, else the selected slot
      const slots = inv.slots;
      let j = slots.findIndex((it, k) => k < HOT && it && it.kind === 'block' && it.id === id);
      if (j < 0) j = slots.findIndex((it, k) => k < HOT && !it);
      if (j < 0) j = inv.selected | 0;
      slots[j] = { kind: 'block', id, count: STACK_MAX };
      this.game.audio?.play?.('ui_click', { volume: 0.6 });
      this._commit();
      return;
    }
    const n = right ? 1 : STACK_MAX;
    if (this.held && this.held.kind === 'block' && this.held.id === id) this.held.count = Math.min(STACK_MAX, right ? this.held.count + 1 : STACK_MAX);
    else { this.held = { kind: 'block', id, count: n }; this.heldFrom = -1; }
    this.game.audio?.play?.('ui_click', { volume: 0.6 });
    this._showTip(null);
    this._renderCursor();
  }

  /** Put the held stack back (origin slot, else merge / first free slot; palette stacks may vanish). */
  _returnHeld() {
    const h = this.held;
    if (!h) return;
    const inv = this.inv;
    this.held = null;
    if (!inv) return;
    const slots = inv.slots;
    if (this.heldFrom >= 0 && !slots[this.heldFrom]) { slots[this.heldFrom] = h; this.heldFrom = -1; return; }
    if (h.kind === 'block') {
      for (let j = 0; j < SLOTS && h.count > 0; j++) {
        const t = slots[j];
        if (canStack(t, h) && t.count < STACK_MAX) { const k = Math.min(h.count, STACK_MAX - t.count); t.count += k; h.count -= k; }
      }
      if (h.count <= 0) return;
    }
    const e = slots.findIndex((it) => !it);
    if (e >= 0) slots[e] = h;
    else if (this.heldFrom >= 0) {
      // should not happen (we only ever hold what came out of a slot), but never lose a weapon
      if (typeof inv.addItem === 'function') inv.addItem(h);
    }
    this.heldFrom = -1;
  }

  /** Tell the inventory its slots changed (keeps weaponChanged consistent for the selected slot). */
  _commit() {
    const inv = this.inv;
    if (!inv) return;
    for (let i = 0; i < SLOTS; i++) {
      const it = inv.slots[i];
      if (it && it.kind === 'block' && !(it.count > 0)) inv.slots[i] = null;
    }
    if (typeof inv.notifyChanged === 'function') inv.notifyChanged();
    else {
      const key = itemKey(inv.getSelected ? inv.getSelected() : inv.slots[inv.selected | 0]);
      if (key !== this._lastSelKey) {
        this._lastSelKey = key;
        this.game.events.emit('weaponChanged', { item: inv.getSelected ? inv.getSelected() : null, slot: inv.selected | 0 });
      }
      this.game.events.emit('inventoryChanged', {});
    }
    this.render();
  }

  update(dt) {
    if (!this.isOpen) return;
    const input = this.game.input;
    // number keys over a slot: swap with that hotbar slot (Minecraft)
    if (input && this.hover >= 0 && !this.held) {
      for (let n = 0; n < HOT; n++) {
        if (input.pressed('slot' + (n + 1), true)) {
          if (n !== this.hover) {
            const s = this.inv.slots;
            const t = s[n]; s[n] = s[this.hover]; s[this.hover] = t;
            this.game.audio?.play?.('ui_click', { volume: 0.6 });
            this._commit();
          }
          break;
        }
      }
    }
    this._statsT -= dt;
    if (this._statsT <= 0) { this._statsT = 0.25; this._updateStats(); this.render(); }
  }

  /** Debug/test helper: perform a click on slot i. */
  debugClick(i, right = false, shift = false) { if (this.isOpen) this._click(i, right, shift); }
  debugPalette(id, right = false, shift = false) { if (this.isOpen) this._palette(id, right, shift); }

  /** Clone of the held stack (tests). */
  get heldItem() { return cloneItem(this.held); }
}
