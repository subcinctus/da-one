// Minecraft-style hotbar (bottom-centre): 9 bevelled slots with block / weapon / tool icons, stack counts or
// ammo, the white selection frame, and the item-name popup that fades after a selection change.
// Touch mode: tapping a slot selects it.
import { el } from './styles.js';
import { setIcon } from './icons.js';
import { itemName } from '../data/items.js';
import { WEAPONS } from '../data/weapons.js';

const N = 9;

export class Hotbar {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.slots = [];
    this._sigs = new Array(N).fill(null);
    this._sel = -1;
    this._selKey = null;
    this._nameT = 0;
    this._dirty = true;
    this._checkT = 0;
    this._creative = null;
    this._counts = new Array(N).fill(0);
  }

  mount(parent) {
    this.name = el('div', 'bc-iname', parent);
    this.bar = el('div', 'bc-hotbar', parent);
    for (let i = 0; i < N; i++) {
      const s = el('div', 'bc-slot', this.bar);
      el('span', 'num', s, String(i + 1));
      const ico = el('div', 'ico', s);
      const cnt = el('span', 'cnt', s);
      s.addEventListener('pointerdown', (e) => {
        if (!this.hud.touchMode) return;
        e.preventDefault(); e.stopPropagation();
        const inv = this.game.inventory;
        if (inv && typeof inv.select === 'function' && !this.game.uiOpen) inv.select(i);
      });
      this.slots.push({ s, ico, cnt });
    }
  }

  /** Mark contents dirty (inventoryChanged / weaponChanged). */
  invalidate() { this._dirty = true; }

  update(dt) {
    const inv = this.game.inventory;
    if (!inv || !Array.isArray(inv.slots)) return;
    this._checkT -= dt;
    if (this._dirty || this._checkT <= 0) {
      this._dirty = false;
      this._checkT = 0.12;
      this._sync(inv);
    }
    const inVeh = !!(this.game.player && this.game.player.inVehicle);
    if (inVeh !== this._dim) { this._dim = inVeh; this.bar.classList.toggle('dim', inVeh); }
    if (this._nameT > 0) {
      this._nameT -= dt;
      if (this._nameT <= 0) this.name.classList.remove('on');
    }
  }

  _sync(inv) {
    const world = this.game.world;
    const creative = !!inv.creative;
    for (let i = 0; i < N; i++) {
      const it = inv.slots[i] || null;
      const sig = it ? it.kind + ':' + it.id + ':' + (it.count | 0) + ':' + (it.mag | 0) + ':' + (it.reserve | 0) + (creative ? 'c' : '') : '';
      if (sig === this._sigs[i]) continue;
      const prevCount = this._counts[i];
      this._sigs[i] = sig;
      const slot = this.slots[i];
      setIcon(slot.ico, it, world);
      let txt = '', cls = 'cnt';
      if (it && it.kind === 'block') {
        if (!creative && it.count > 1) txt = String(it.count);
        this._counts[i] = it.count | 0;
        if (prevCount && it.count > prevCount) this._bump(slot.s);
      } else {
        this._counts[i] = 0;
        if (it && it.kind === 'weapon' && WEAPONS[it.id] && WEAPONS[it.id].mag > 0) {
          txt = String((it.mag | 0) + (it.reserve | 0));
          cls = 'cnt ammo' + ((it.mag | 0) + (it.reserve | 0) === 0 ? ' zero' : '');
        }
      }
      if (slot.cnt.textContent !== txt) slot.cnt.textContent = txt;
      if (slot.cnt.className !== cls) slot.cnt.className = cls;
    }
    const sel = Math.max(0, Math.min(N - 1, inv.selected | 0));
    if (sel !== this._sel) {
      if (this._sel >= 0) this.slots[this._sel].s.classList.remove('sel');
      this.slots[sel].s.classList.add('sel');
      this._sel = sel;
    }
    // item name popup when the selected item changes (slot switch or different item in the slot)
    const cur = inv.slots[sel] || null;
    const key = sel + '|' + (cur ? cur.kind + ':' + cur.id : '');
    if (key !== this._selKey) {
      const first = this._selKey === null;
      this._selKey = key;
      if (!first && cur) this._popName(cur);
      else if (!cur) { this.name.classList.remove('on'); this._nameT = 0; }
    }
    this._creative = creative;
  }

  _popName(item) {
    let html = itemName(item).replace(/[<>&]/g, '');
    if (item.kind === 'weapon' && WEAPONS[item.id] && WEAPONS[item.id].mag > 0) html += '<small>' + (item.mag | 0) + ' / ' + (item.reserve | 0) + '</small>';
    else if (item.kind === 'block' && !this.game.inventory?.creative) html += '<small>x' + (item.count | 0) + '</small>';
    this.name.innerHTML = html;
    this.name.classList.add('on');
    this._nameT = 1.8;
  }

  _bump(s) {
    const ico = s.querySelector('.ico');
    if (ico && ico.animate) {
      ico.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3) translateY(-3px)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: 250, easing: 'ease-out' });
    }
  }
}
