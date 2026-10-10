// DOM for the shop panels (gun shop, hardware store, hospital, Pay'n'Spray, safehouse) + the shared stylesheet used by
// the mission log and the fallback modal. Each builder returns { el, refresh() }; shops.js mounts `el` inside
// hud.openPanel (or a fallback modal) and calls refresh() after every transaction.
import { WEAPONS } from '../data/weapons.js';
import { BLOCKS, B } from '../world/blocks.js';
import { TOOLS } from '../data/items.js';
import * as UIIcons from '../ui/icons.js';
import {
  gunCatalog, ARMOR_PRICE, HEAL_PRICE, RESPRAY_PRICE, RESPRAY_COLORS, hardwareCatalog, TNT_PACKS, TOOL_PRICES,
  TOOL_LIST, stackPrice,
} from './shop_defs.js';
import { h, injectCss, fmtMoney, hexCss, esc, uiLayer, HAS_DOM } from './util.js';

export const SHOP_CSS = `
.bcm-shop { display: flex; flex-direction: column; gap: 14px; color: var(--fg, #f2f4f8); }
.bcm-shop * { box-sizing: border-box; }
.bcm-cashbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px;
  background: linear-gradient(90deg, rgba(255,255,255,.07), rgba(255,255,255,.02)); border: 1px solid var(--panel-border, rgba(255,255,255,.12));
  border-radius: 10px; }
.bcm-cashbar .lbl { font: 700 11px/1 var(--font); letter-spacing: .16em; color: #aab3c0; text-transform: uppercase; }
.bcm-cashbar .v { font: 800 28px/1 var(--font-display); letter-spacing: .03em; color: #7ee07a; text-shadow: 0 2px 0 rgba(0,0,0,.45); }
.bcm-cashbar .v.flash { animation: bcm-cash .55s ease; }
.bcm-cashbar .side { text-align: right; font: 600 13px/1.35 var(--font); color: #c9d1dc; }
@keyframes bcm-cash { 0% { transform: scale(1); } 30% { transform: scale(1.12); color: #fff; } 100% { transform: scale(1); } }
.bcm-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.bcm-tab { pointer-events: auto; cursor: pointer; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--panel-border, rgba(255,255,255,.12));
  background: rgba(255,255,255,.05); color: #dfe4ea; font: 700 13px/1 var(--font); letter-spacing: .02em; transition: background .15s, color .15s; }
.bcm-tab:hover { background: rgba(255,255,255,.12); }
.bcm-tab.on { background: var(--accent, #f5c518); color: #1a1405; border-color: transparent; }
.bcm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; }
.bcm-card { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px;
  background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); transition: border-color .15s, background .15s, transform .15s; }
.bcm-card:hover { border-color: rgba(255,255,255,.24); background: rgba(255,255,255,.075); }
.bcm-card.pop { animation: bcm-pop .45s ease; }
@keyframes bcm-pop { 0% { transform: scale(1); } 35% { transform: scale(1.04); border-color: #7ee07a; } 100% { transform: scale(1); } }
.bcm-card .top { display: flex; align-items: center; gap: 10px; }
.bcm-ico { width: 48px; height: 48px; flex: none; display: flex; align-items: center; justify-content: center; border-radius: 8px;
  background: radial-gradient(circle at 50% 40%, rgba(255,255,255,.12), rgba(255,255,255,.02)); font-size: 28px; }
.bcm-ico img { width: 44px; height: 44px; image-rendering: pixelated; }
.bcm-ico.big { width: 72px; height: 72px; } .bcm-ico.big img { width: 64px; height: 64px; }
.bcm-nm { font: 700 14px/1.2 var(--font); color: #fff; }
.bcm-sub { font: 600 12px/1.3 var(--font); color: #9aa4b2; }
.bcm-pr { font: 800 13px/1 var(--font); color: #9fe39b; }
.bcm-btns { display: flex; gap: 6px; margin-top: auto; }
.bcm-btn { pointer-events: auto; cursor: pointer; flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; padding: 0 10px; border-radius: 7px; border: 1px solid rgba(0,0,0,.5);
  background: linear-gradient(#3a4150, #272c37); color: #fff; font: 700 13px/1 var(--font); letter-spacing: .02em;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 2px 0 rgba(0,0,0,.35); transition: filter .12s, transform .08s; white-space: nowrap; }
.bcm-btn:hover { filter: brightness(1.18); }
.bcm-btn:active { transform: translateY(1px); }
.bcm-btn.buy { background: linear-gradient(#3fb950, #23863a); }
.bcm-btn.gold { background: linear-gradient(#ffd84a, #e3aa00); color: #1a1405; }
.bcm-btn.blue { background: linear-gradient(#4aa3ff, #1f6fd6); }
.bcm-btn.red { background: linear-gradient(#ff6b5f, #c9271d); }
.bcm-btn.poor { background: linear-gradient(#5a3a3a, #3c2626); color: #ffb3ad; }
.bcm-btn[disabled] { opacity: .45; pointer-events: none; }
.bcm-btn.shake { animation: bcm-shake .38s ease; }
.bcm-btn .q { opacity: .75; font-weight: 600; }
@keyframes bcm-shake { 20%, 60% { transform: translateX(-4px); } 40%, 80% { transform: translateX(4px); } }
.bcm-row { display: flex; align-items: center; gap: 14px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.045);
  border: 1px solid rgba(255,255,255,.08); transition: border-color .15s, background .15s; }
.bcm-row:hover { border-color: rgba(255,255,255,.22); background: rgba(255,255,255,.07); }
.bcm-row.pop { animation: bcm-pop .45s ease; }
.bcm-row .mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.bcm-row .acts { display: flex; flex-direction: column; gap: 6px; width: 170px; flex: none; }
.bcm-tag { display: inline-block; margin-left: 8px; padding: 2px 7px; border-radius: 999px; font: 800 10px/1.4 var(--font); letter-spacing: .1em;
  text-transform: uppercase; vertical-align: 2px; background: rgba(126,224,122,.18); color: #7ee07a; }
.bcm-tag.red { background: rgba(229,72,77,.18); color: #ff8a84; } .bcm-tag.blue { background: rgba(77,155,255,.18); color: #8cc2ff; }
.bcm-tag.gold { background: rgba(245,197,24,.18); color: #ffd84a; }
.bcm-bars { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 10px; }
.bcm-bar { display: flex; flex-direction: column; gap: 2px; font: 700 9px/1 var(--font); letter-spacing: .12em; color: #8c96a5; text-transform: uppercase; }
.bcm-bar i { display: block; height: 5px; border-radius: 3px; background: rgba(255,255,255,.1); overflow: hidden; }
.bcm-bar i b { display: block; height: 100%; background: linear-gradient(90deg, #f5c518, #ff8a1f); border-radius: 3px; }
.bcm-meter { height: 10px; border-radius: 5px; background: rgba(255,255,255,.1); overflow: hidden; border: 1px solid rgba(0,0,0,.4); }
.bcm-meter b { display: block; height: 100%; border-radius: 4px; transition: width .4s ease; }
.bcm-hero { display: flex; align-items: center; gap: 16px; padding: 14px; border-radius: 12px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); }
.bcm-hero .mid { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.bcm-banner { padding: 10px 14px; border-radius: 10px; font: 600 13px/1.4 var(--font); background: rgba(245,197,24,.12); border: 1px solid rgba(245,197,24,.35); color: #ffe38a; }
.bcm-banner.blue { background: rgba(77,155,255,.12); border-color: rgba(77,155,255,.35); color: #b9d8ff; }
.bcm-swatches { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
.bcm-sw { pointer-events: auto; cursor: pointer; aspect-ratio: 1; border-radius: 8px; border: 2px solid rgba(0,0,0,.6);
  box-shadow: inset 0 -6px 0 rgba(0,0,0,.18), inset 0 2px 0 rgba(255,255,255,.25); transition: transform .12s; }
.bcm-sw:hover { transform: scale(1.08); }
.bcm-sw.on { outline: 3px solid #fff; outline-offset: 2px; }
.bcm-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font: 600 13px/1.3 var(--font); }
.bcm-kv .k { color: #9aa4b2; } .bcm-kv .v { color: #fff; text-align: right; }
.bcm-foot { font: 500 12px/1.4 var(--font); color: #8c96a5; text-align: center; }
.bcm-foot kbd { display: inline-block; padding: 0 5px; border-radius: 4px; background: #e6e9ee; color: #111; font: 700 11px/1.5 var(--font); }
/* fallback modal (no HUD panel API) */
.bcm-modal { position: absolute; inset: 0; z-index: 60; pointer-events: auto; display: flex; align-items: center; justify-content: center;
  background: rgba(5,7,12,.55); backdrop-filter: blur(3px); }
.bcm-modal .win { width: min(var(--w, 640px), 94vw); max-height: 90vh; display: flex; flex-direction: column; background: var(--panel, rgba(12,15,22,.92));
  border: 1px solid var(--panel-border, rgba(255,255,255,.12)); border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.55); animation: bcm-in .22s ease both; }
.bcm-modal header { display: flex; align-items: center; gap: 12px; padding: 16px 18px 14px 22px; border-bottom: 1px solid var(--panel-border, rgba(255,255,255,.12)); }
.bcm-modal header h2 { flex: 1; margin: 0; font: 800 28px/1 var(--font-display); letter-spacing: .05em; text-transform: uppercase; color: #fff; }
.bcm-modal header button { pointer-events: auto; cursor: pointer; width: 36px; height: 36px; border-radius: 8px; border: 1px solid rgba(255,255,255,.15);
  background: rgba(255,255,255,.06); color: #fff; font-size: 18px; }
.bcm-modal .bd { overflow: auto; padding: 18px 22px 22px; }
@keyframes bcm-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
@media (max-width: 640px) { .bcm-row { flex-wrap: wrap; } .bcm-row .acts { width: 100%; flex-direction: row; } .bcm-bars { grid-template-columns: repeat(2, 1fr); } }
`;

export function injectShopCss() { injectCss('shop', SHOP_CSS); }

// ------------------------------------------------------------------------------------------------ icons

const PIX = {
  heart: { rows: ['.kk...kk.', 'kRRk.kRRk', 'kRWRkRRRk', 'kRRRRRRRk', '.kRRRRRk.', '..kRRRk..', '...kRk...', '....k....'], pal: { k: '#5c0d14', R: '#e5312f', W: '#ffffff' } },
  vest: { rows: ['.kk...kk.', 'kBBk.kBBk', 'kBBBBBBBk', 'kBLLLLLBk', 'kBLLLLLBk', 'kBBBYBBBk', 'kDDDDDDDk', 'kBBBBBBBk', '.kkkkkkk.'], pal: { k: '#0e1a33', B: '#2f63c8', L: '#4d8bf0', D: '#1d2a44', Y: '#f5c518' } },
  bed: { rows: ['............', '............', '............', 'WWW.........', 'WWWRRRRRRRRR', 'WWWRRRRRRRRR', 'bbbbbbbbbbbb', 'b..........b', 'b..........b'], pal: { W: '#f2f2f2', R: '#c0392b', b: '#7a5230' } },
  disk: { rows: ['kkkkkkkk.', 'kBWWWWBBk', 'kBWWWWBBk', 'kBBBBBBBk', 'kBkkkkkBk', 'kBkSSkkBk', 'kBkSSkkBk', 'kkkkkkkkk'], pal: { k: '#0e1a33', B: '#3f6fd6', W: '#e8edf2', S: '#9aa4b2' } },
  flag: { rows: ['...kkkk...', '..kBBBBk..', '.kBBWWBBk.', '.kBWWWWBk.', '.kBBWWBBk.', '..kBBBBk..', '...kBBk...', '....kk....'], pal: { k: '#0e1a33', B: '#3fa9ff', W: '#ffffff' } },
  can: { rows: ['...kk....', '..kGGk.g.', '.kkkkkk..', '.kGGGGk.g', '.kGWGGk..', '.kGWGGk..', '.kGGGGk..', '.kkkkkk..'], pal: { k: '#0d2a12', G: '#46c46f', W: '#d8ffe0', g: '#9be59f' } },
  star: { rows: ['....k....', '...kYk...', 'kkkkYkkkk', 'kYYYYYYYk', '.kYYYYYk.', '..kYYYk..', '.kYk.kYk.', 'kk.....kk'], pal: { k: '#5a4300', Y: '#f5c518' } },
};
const _pixCache = new Map();
/** data: URL of a tiny pixel-art icon. */
export function pixIcon(name, scale = 6) {
  if (!HAS_DOM) return '';
  const key = name + '@' + scale;
  if (_pixCache.has(key)) return _pixCache.get(key);
  const def = PIX[name];
  if (!def) return '';
  const w = Math.max(...def.rows.map((r) => r.length)), hgt = def.rows.length;
  const c = document.createElement('canvas');
  c.width = w * scale; c.height = hgt * scale;
  const g = c.getContext('2d');
  def.rows.forEach((row, y) => [...row].forEach((ch, x) => { const col = def.pal[ch]; if (col) { g.fillStyle = col; g.fillRect(x * scale, y * scale, scale, scale); } }));
  const url = c.toDataURL();
  _pixCache.set(key, url);
  return url;
}

/** Fill an icon box with an item icon (block atlas icon / weapon pixel sprite / emoji fallback). */
export function itemIcon(box, item, game) {
  box.textContent = '';
  let info = null;
  try { if (typeof UIIcons.itemIconInfo === 'function') info = UIIcons.itemIconInfo(item, game && game.world); } catch (e) { info = null; }
  if (!info && item.kind === 'block') {
    const tex = game && game.world && game.world.textures;
    try {
      if (tex && typeof tex.getIconURL === 'function') info = { url: tex.getIconURL(item.id) };
      else if (tex && typeof tex.getIcon === 'function') { const c = tex.getIcon(item.id); if (c) info = { url: c.toDataURL() }; }
    } catch (e) { info = null; }
  }
  if (info && info.url) {
    const img = h('img', '', box);
    img.src = info.url;
    img.alt = '';
    img.draggable = false;
    return;
  }
  let emoji = (info && info.emoji) || null;
  if (!emoji && item.kind === 'weapon') emoji = (WEAPONS[item.id] && WEAPONS[item.id].icon) || '🔫';
  if (!emoji && item.kind === 'tool') emoji = (TOOLS[item.id] && TOOLS[item.id].icon) || '⛏️';
  if (!emoji && item.kind === 'block') {
    const def = BLOCKS[item.id];
    const sq = h('div', '', box);
    sq.style.cssText = `width:30px;height:30px;border-radius:4px;background:${hexCss(def ? def.color : 0x888888)};box-shadow:inset 0 -6px 0 rgba(0,0,0,.25),inset 0 3px 0 rgba(255,255,255,.25)`;
    return;
  }
  box.textContent = emoji || '?';
}

function pixImg(box, name) {
  const url = pixIcon(name);
  if (!url) return;
  const img = h('img', '', box);
  img.src = url;
  img.alt = '';
}

function cashBar(parent, game, sideHtml) {
  const bar = h('div', 'bcm-cashbar', parent);
  const left = h('div', '', bar);
  h('div', 'lbl', left, 'Your cash');
  const v = h('div', 'v', left, fmtMoney(game.player ? game.player.money : 0));
  const side = h('div', 'side', bar);
  if (sideHtml) side.innerHTML = sideHtml;
  let last = game.player ? game.player.money : 0;
  return {
    side,
    refresh() {
      const m = game.player ? game.player.money : 0;
      v.textContent = fmtMoney(m);
      if (m !== last) { v.classList.remove('flash'); void v.offsetWidth; v.classList.add('flash'); last = m; }
    },
  };
}

function priceBtn(parent, label, price, cls, onClick) {
  const b = h('button', 'bcm-btn ' + (cls || 'buy'), parent);
  b.type = 'button';
  b.innerHTML = esc(label) + (price > 0 ? ' <span class="q">' + fmtMoney(price) + '</span>' : '');
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
  b._price = price;
  return b;
}

function setAffordable(btn, money) {
  if (!btn || btn.disabled) return;
  btn.classList.toggle('poor', btn._price > 0 && money < btn._price);
}

function pop(el) { if (!el) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

// ================================================================================================ gun shop

/** ctx: {game, shops, poi}. */
export function buildGunShop(ctx) {
  injectShopCss();
  const { game, shops } = ctx;
  const root = h('div', 'bcm-shop');
  const cash = cashBar(root, game, 'Guns, ammo &amp; body armor.<br>Prices include sales tax.');
  const list = h('div', '', root);
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const btns = [];

  // body armor
  const ar = h('div', 'bcm-row', list);
  const arIco = h('div', 'bcm-ico', ar); pixImg(arIco, 'vest');
  const arMid = h('div', 'mid', ar);
  const arName = h('div', 'bcm-nm', arMid, 'Body Armor');
  const arSub = h('div', 'bcm-sub', arMid, 'Absorbs 60% of incoming damage until depleted.');
  const arMeter = h('div', 'bcm-meter', arMid);
  const arFill = h('b', '', arMeter); arFill.style.background = 'linear-gradient(90deg,#3f8fe0,#7cc0ff)';
  const arActs = h('div', 'acts', ar);
  const arBtn = priceBtn(arActs, 'Buy armor', ARMOR_PRICE, 'blue', (b) => {
    shops.purchase(ARMOR_PRICE, 'Body Armor', () => {
      const p = game.player;
      if ((p.armor || 0) >= (p.maxArmor || 100) - 0.5) return 'Your armor is already full.';
      p.addArmor?.(100);
      return true;
    }, b, ar);
  });
  btns.push(arBtn);
  void arName; void arSub;

  const rows = [];
  for (const w of gunCatalog()) {
    const row = h('div', 'bcm-row', list);
    const ico = h('div', 'bcm-ico', row);
    itemIcon(ico, { kind: 'weapon', id: w.id }, game);
    const mid = h('div', 'mid', row);
    const nm = h('div', 'bcm-nm', mid, w.name);
    const tag = h('span', 'bcm-tag', nm, 'Owned');
    const bars = h('div', 'bcm-bars', mid);
    for (const [k, label] of [['damage', 'Damage'], ['rate', 'Fire rate'], ['range', 'Range'], ['accuracy', 'Accuracy']]) {
      const b = h('div', 'bcm-bar', bars, label);
      const i = h('i', '', b); const fill = h('b', '', i); fill.style.width = Math.round(w.stats[k] * 100) + '%';
    }
    const acts = h('div', 'acts', row);
    const buy = priceBtn(acts, 'Buy', w.price, 'buy', (b) => {
      shops.purchase(w.price, w.name, () => {
        const inv = game.inventory;
        if (!inv) return false;
        if (inv.hasWeapon?.(w.id)) return 'You already own the ' + w.name + '.';
        return inv.addWeapon(w.id, shops.purchaseRounds(w.id)) ? true : 'Your inventory is full.';
      }, b, row);
    });
    let ammo = null;
    if (w.ammo) {
      ammo = priceBtn(acts, '+' + w.ammo.rounds + (w.kind === 'throw' ? ' grenades' : w.kind === 'projectile' ? ' rockets' : ' rounds'), w.ammo.price, 'gold', (b) => {
        shops.purchase(w.ammo.price, w.name + ' ammo', () => {
          const inv = game.inventory;
          if (!inv || !inv.hasWeapon?.(w.id)) return 'Buy the ' + w.name + ' first.';
          return inv.addAmmo(w.id, w.ammo.rounds) ? true : false;
        }, b, row);
      });
    }
    rows.push({ w, tag, buy, ammo });
    btns.push(buy);
    if (ammo) btns.push(ammo);
  }
  h('div', 'bcm-foot', root).innerHTML = '<kbd>Esc</kbd> or ✕ to leave.';

  function refresh() {
    cash.refresh();
    const p = game.player;
    const money = p ? p.money : 0;
    const armor = p ? p.armor || 0 : 0;
    arFill.style.width = Math.round(Math.min(1, armor / (p && p.maxArmor || 100)) * 100) + '%';
    arBtn.disabled = armor >= ((p && p.maxArmor) || 100) - 0.5;
    arBtn.innerHTML = arBtn.disabled ? 'Armor full' : 'Buy armor <span class="q">' + fmtMoney(ARMOR_PRICE) + '</span>';
    const inv = game.inventory;
    for (const r of rows) {
      const owned = !!(inv && inv.hasWeapon?.(r.w.id));
      r.tag.style.display = owned ? '' : 'none';
      r.buy.disabled = owned;
      r.buy.innerHTML = owned ? 'Owned' : 'Buy <span class="q">' + fmtMoney(r.w.price) + '</span>';
      if (r.ammo) r.ammo.disabled = !owned;
    }
    for (const b of btns) setAffordable(b, money);
  }
  refresh();
  return { el: root, refresh };
}

// ================================================================================================ hardware store

export function buildHardware(ctx) {
  injectShopCss();
  const { game, shops } = ctx;
  const root = h('div', 'bcm-shop');
  const cash = cashBar(root, game, 'Building supplies by the stack.<br>Full stacks of 64 are 10% off.');
  const banner = h('div', 'bcm-banner', root);
  const tabs = h('div', 'bcm-tabs', root);
  const body = h('div', '', root);
  const cats = hardwareCatalog();
  const tabNames = [...cats.map((c) => c.name), 'Explosives & Tools', 'Game Mode'];
  let current = shops._hwTab && tabNames.includes(shops._hwTab) ? shops._hwTab : tabNames[0];
  const tabEls = [];
  let btns = [];
  for (const name of tabNames) {
    const t = h('button', 'bcm-tab', tabs, name);
    t.type = 'button';
    t.addEventListener('click', (e) => { e.stopPropagation(); current = name; shops._hwTab = name; game.audio?.play?.('ui_click'); render(); });
    tabEls.push(t);
  }

  function blockCard(grid, item) {
    const def = BLOCKS[item.id];
    const card = h('div', 'bcm-card', grid);
    const top = h('div', 'top', card);
    const ico = h('div', 'bcm-ico', top);
    itemIcon(ico, { kind: 'block', id: item.id, count: 1 }, game);
    const txt = h('div', '', top);
    h('div', 'bcm-nm', txt, def.name);
    h('div', 'bcm-pr', txt, fmtMoney(item.price) + ' / block');
    const row = h('div', 'bcm-btns', card);
    for (const n of [16, 64]) {
      const price = stackPrice(item.price, n);
      btns.push(priceBtn(row, '×' + n, price, n === 64 ? 'gold' : 'buy', (b) => {
        shops.purchase(price, n + ' ' + def.name, () => {
          const inv = game.inventory;
          if (!inv) return false;
          const ok = inv.addBlock(item.id, n);
          const over = Number(inv.lastOverflow) || 0;
          if (!ok && over >= n) return 'Your inventory is full.';
          return over > 0 ? (n - over) / n : true;
        }, b, card);
      }));
    }
  }

  function render() {
    body.textContent = '';
    btns = [];
    tabEls.forEach((t, i) => t.classList.toggle('on', tabNames[i] === current));
    const cat = cats.find((c) => c.name === current);
    if (cat) {
      const grid = h('div', 'bcm-grid', body);
      for (const it of cat.items) blockCard(grid, it);
    } else if (current === 'Explosives & Tools') {
      const grid = h('div', 'bcm-grid', body);
      for (const pack of TNT_PACKS) {
        const card = h('div', 'bcm-card', grid);
        const top = h('div', 'top', card);
        const ico = h('div', 'bcm-ico', top);
        itemIcon(ico, { kind: 'block', id: B.TNT, count: 1 }, game);
        const txt = h('div', '', top);
        h('div', 'bcm-nm', txt, 'TNT ×' + pack.count);
        h('div', 'bcm-sub', txt, 'Place it, then [RMB] it with an empty hand.'.replace('[RMB]', 'right-click'));
        const row = h('div', 'bcm-btns', card);
        btns.push(priceBtn(row, 'Buy', pack.price, 'red', (b) => {
          shops.purchase(pack.price, pack.count + ' TNT', () => {
            const inv = game.inventory;
            if (!inv) return false;
            const ok = inv.addBlock(B.TNT, pack.count);
            const over = Number(inv.lastOverflow) || 0;
            if (!ok && over >= pack.count) return 'Your inventory is full.';
            return over > 0 ? (pack.count - over) / pack.count : true;
          }, b, card);
        }));
      }
      for (const id of TOOL_LIST) {
        const t = TOOLS[id];
        const card = h('div', 'bcm-card', grid);
        const top = h('div', 'top', card);
        const ico = h('div', 'bcm-ico', top);
        itemIcon(ico, { kind: 'tool', id }, game);
        const txt = h('div', '', top);
        h('div', 'bcm-nm', txt, t.name);
        h('div', 'bcm-sub', txt, id === 'pickaxe' ? 'Stone, ores, concrete.' : id === 'axe' ? 'Wood, crates, shelves.' : 'Dirt, sand, gravel, snow.');
        const row = h('div', 'bcm-btns', card);
        const owned = !!game.inventory?.hasTool?.(id);
        const b = priceBtn(row, owned ? 'Owned' : 'Buy', owned ? 0 : TOOL_PRICES[id], 'buy', (bb) => {
          shops.purchase(TOOL_PRICES[id], t.name, () => {
            const inv = game.inventory;
            if (!inv) return false;
            if (inv.hasTool?.(id)) return 'You already have a ' + t.name + '.';
            return inv.addItem({ kind: 'tool', id }) ? true : 'Your inventory is full.';
          }, bb, card);
        });
        b.disabled = owned;
        btns.push(b);
      }
    } else {
      // creative mode toggle
      const hero = h('div', 'bcm-hero', body);
      const ico = h('div', 'bcm-ico big', hero); pixImg(ico, 'star');
      const mid = h('div', 'mid', hero);
      const on = !!game.inventory?.creative;
      h('div', 'bcm-nm', mid, 'Creative Mode: ' + (on ? 'ON' : 'OFF'));
      h('div', 'bcm-sub', mid, 'Unlimited blocks from the full palette in your inventory [E], and double-tap Space to fly. ' +
        'Survival mode: blocks are used up and mining pays cash for ores.');
      const row = h('div', 'bcm-btns', mid);
      const b = priceBtn(row, on ? 'Switch to Survival' : 'Enable Creative Mode', 0, on ? 'blue' : 'gold', () => {
        const inv = game.inventory;
        if (!inv) return;
        const v = !inv.creative;
        if (typeof inv.setCreative === 'function') inv.setCreative(v); else inv.creative = v;
        game.audio?.play?.('purchase');
        game.hud?.notify?.(v ? 'Creative mode *ON*: unlimited blocks, double-tap [Space] to fly.' : 'Creative mode *OFF*: back to survival.', { duration: 3.5 });
        render();
      });
      b.style.maxWidth = '260px';
    }
    refresh();
  }

  function refresh() {
    cash.refresh();
    const on = !!game.inventory?.creative;
    banner.style.display = on ? '' : 'none';
    banner.textContent = 'Creative mode is ON: every block is free and unlimited in your inventory [E]. Stock up anyway if you like.';
    const money = game.player ? game.player.money : 0;
    for (const b of btns) setAffordable(b, money);
  }
  render();
  return { el: root, refresh };
}

// ================================================================================================ hospital

export function buildHospital(ctx) {
  injectShopCss();
  const { game, shops } = ctx;
  const root = h('div', 'bcm-shop');
  const cash = cashBar(root, game, 'St. Brick Hospital<br>Walk-in clinic, no appointment needed.');
  const hero = h('div', 'bcm-hero', root);
  const ico = h('div', 'bcm-ico big', hero); pixImg(ico, 'heart');
  const mid = h('div', 'mid', hero);
  const title = h('div', 'bcm-nm', mid, 'Patch me up');
  const sub = h('div', 'bcm-sub', mid, '');
  const meter = h('div', 'bcm-meter', mid);
  const fill = h('b', '', meter); fill.style.background = 'linear-gradient(90deg,#3fb950,#8ef08a)';
  const row = h('div', 'bcm-btns', mid);
  const btn = priceBtn(row, 'Full treatment', HEAL_PRICE, 'buy', (b) => {
    shops.purchase(HEAL_PRICE, 'Medical treatment', () => {
      const p = game.player;
      if ((p.health || 0) >= (p.maxHealth || 100) - 0.5) return 'You are already in perfect health.';
      p.heal?.(p.maxHealth || 100);
      return true;
    }, b, hero);
  });
  btn.style.maxWidth = '260px';
  void title;
  h('div', 'bcm-foot', root).innerHTML = 'Getting wasted lands you here too, with a $100 bill and no armor.';
  function refresh() {
    cash.refresh();
    const p = game.player || {};
    const hp = Math.round(p.health || 0), max = p.maxHealth || 100;
    fill.style.width = Math.round(Math.min(1, hp / max) * 100) + '%';
    sub.textContent = 'Health: ' + hp + ' / ' + max + (hp >= max - 0.5 ? '  ·  You look great.' : '  ·  Treatment restores full health.');
    btn.disabled = hp >= max - 0.5;
    btn.innerHTML = btn.disabled ? 'Perfect health' : 'Full treatment <span class="q">' + fmtMoney(HEAL_PRICE) + '</span>';
    setAffordable(btn, p.money || 0);
  }
  refresh();
  return { el: root, refresh };
}

// ================================================================================================ pay'n'spray

export function buildGarage(ctx) {
  injectShopCss();
  const { game, shops } = ctx;
  const root = h('div', 'bcm-shop');
  const v = game.player && game.player.inVehicle;
  const cash = cashBar(root, game, 'Pixel Pay\'n\'Spray<br>New paint, new plates, no questions.');
  const hero = h('div', 'bcm-hero', root);
  const ico = h('div', 'bcm-ico big', hero); pixImg(ico, 'can');
  const mid = h('div', 'mid', hero);
  const name = h('div', 'bcm-nm', mid, v ? ((v.def && v.def.name) || v.type || 'Vehicle') : 'No vehicle');
  const sub = h('div', 'bcm-sub', mid, '');
  const meter = h('div', 'bcm-meter', mid);
  const fill = h('b', '', meter);
  const wantedEl = h('div', 'bcm-sub', mid, '');
  void name;
  h('div', 'bcm-nm', root, 'Pick a colour');
  const sw = h('div', 'bcm-swatches', root);
  let chosen = null;
  const swEls = [];
  for (const c of RESPRAY_COLORS) {
    const s = h('div', 'bcm-sw', sw);
    s.style.background = hexCss(c.hex);
    s.title = c.name;
    s.addEventListener('click', (e) => { e.stopPropagation(); chosen = c.hex; game.audio?.play?.('ui_click'); refresh(); });
    swEls.push({ s, c });
  }
  const row = h('div', 'bcm-btns', root);
  const btn = priceBtn(row, 'Respray & repair', RESPRAY_PRICE, 'buy', (b) => {
    const veh = game.player && game.player.inVehicle;
    shops.purchase(RESPRAY_PRICE, 'Respray', () => {
      if (!veh) return 'Drive a vehicle in first.';
      return shops.respray(veh, chosen) ? true : false;
    }, b, hero, { closeAfter: true });
  });
  h('div', 'bcm-foot', root).innerHTML = 'A respray repairs the vehicle and makes the cops lose your trail.';
  // default choice: a colour different from the current one
  if (v) {
    const cur = Number(v.color) >>> 0;
    const alt = RESPRAY_COLORS.find((c) => c.hex !== cur);
    chosen = alt ? alt.hex : RESPRAY_COLORS[0].hex;
  }
  function refresh() {
    cash.refresh();
    const veh = game.player && game.player.inVehicle;
    const hp = veh ? Math.max(0, veh.health || 0) / Math.max(1, veh.maxHealth || 100) : 0;
    fill.style.width = Math.round(hp * 100) + '%';
    fill.style.background = hp > 0.6 ? 'linear-gradient(90deg,#3fb950,#8ef08a)' : hp > 0.3 ? 'linear-gradient(90deg,#e3aa00,#ffd84a)' : 'linear-gradient(90deg,#c9271d,#ff6b5f)';
    sub.textContent = veh ? 'Condition: ' + Math.round(hp * 100) + '%' : 'Drive a vehicle into the marker.';
    const w = (game.police && game.police.wanted) | 0;
    wantedEl.innerHTML = w > 0 ? '<span class="bcm-tag red">Wanted ' + '★'.repeat(w) + '</span> A respray loses the cops.' : '<span class="bcm-tag">Clean</span> No heat on you right now.';
    for (const { s, c } of swEls) s.classList.toggle('on', c.hex === chosen);
    btn.disabled = !veh;
    setAffordable(btn, game.player ? game.player.money : 0);
  }
  refresh();
  return { el: root, refresh };
}

// ================================================================================================ safehouse

export function buildSafehouse(ctx) {
  injectShopCss();
  const { game, shops, poi } = ctx;
  const root = h('div', 'bcm-shop');
  const cash = cashBar(root, game, 'Home sweet home.<br>Save, sleep, gear up.');
  const grid = h('div', 'bcm-grid', root);
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(190px, 1fr))';

  const card = (icon, title, subText) => {
    const c = h('div', 'bcm-card', grid);
    const top = h('div', 'top', c);
    const ico = h('div', 'bcm-ico', top); pixImg(ico, icon);
    const txt = h('div', '', top);
    h('div', 'bcm-nm', txt, title);
    const sub = h('div', 'bcm-sub', txt, subText);
    const row = h('div', 'bcm-btns', c);
    return { c, sub, row };
  };

  const sv = card('disk', 'Save Game', '');
  const saveBtn = priceBtn(sv.row, 'Save now', 0, 'blue', () => {
    const ok = shops.saveGame();
    pop(sv.c);
    refresh();
    if (!ok) saveBtn.classList.add('shake');
  });
  const sl = card('bed', 'Sleep', 'Skip to 08:00, heal up and save.');
  const sleepBtn = priceBtn(sl.row, 'Sleep until morning', 0, 'gold', () => { shops.sleep(); });
  const rp = card('flag', 'Respawn Point', '');
  const rpBtn = priceBtn(rp.row, 'Set respawn here', 0, 'buy', () => {
    shops.setRespawn(poi);
    pop(rp.c);
    refresh();
  });

  const stats = h('div', 'bcm-kv', root);
  function refresh() {
    cash.refresh();
    const info = game.save && typeof game.save.info === 'function' ? game.save.info() : null;
    sv.sub.textContent = info && info.time ? 'Last saved ' + info.ago + '.' : 'No save yet.';
    const rpSet = shops.respawnPoi === poi;
    rp.sub.textContent = rpSet ? 'You wake up here after getting wasted (hospital bill still applies).' : 'Wake up here after getting wasted (hospital bill still applies).';
    rpBtn.disabled = rpSet;
    rpBtn.textContent = rpSet ? 'Respawn point set ✓' : 'Set respawn here';
    void sleepBtn;
    const m = game.missions;
    const done = m && m.completed ? m.completed.size : 0;
    const total = m && typeof m.list === 'function' ? m.list().length : (m && m.defs ? m.defs.length : 0);
    const clock = game.sky && Number.isFinite(game.sky.time) ? String(Math.floor(game.sky.time)).padStart(2, '0') + ':' + String(Math.floor((game.sky.time % 1) * 60)).padStart(2, '0') : '--:--';
    stats.innerHTML = '<span class="k">Missions completed</span><span class="v">' + done + (total ? ' / ' + total : '') + '</span>' +
      '<span class="k">Mission earnings</span><span class="v">' + fmtMoney(m && m.earned || 0) + '</span>' +
      '<span class="k">Time of day</span><span class="v">' + clock + '</span>' +
      '<span class="k">Mode</span><span class="v">' + (game.inventory && game.inventory.creative ? 'Creative' : 'Survival') + '</span>';
  }
  refresh();
  return { el: root, refresh };
}

// ================================================================================================ fallback modal

/** Minimal modal used when the HUD panel API is unavailable. Returns {root, body, close()}. */
export function openFallbackModal(title, element, opts = {}) {
  injectShopCss();
  const layer = h('div', 'bcm-modal', uiLayer());
  const win = h('div', 'win', layer);
  if (opts.width) win.style.setProperty('--w', typeof opts.width === 'number' ? opts.width + 'px' : String(opts.width));
  const header = h('header', '', win);
  h('h2', '', header, title);
  const x = h('button', '', header, '✕');
  x.type = 'button';
  const body = h('div', 'bd', win);
  body.appendChild(element);
  layer.addEventListener('mousedown', (e) => e.stopPropagation());
  let closed = false;
  const rec = {
    root: layer, body,
    close() {
      if (closed) return;
      closed = true;
      layer.remove();
      if (typeof opts.onClose === 'function') { try { opts.onClose(); } catch (e) { console.error('[shops] onClose', e); } }
    },
    get closed() { return closed; },
  };
  x.addEventListener('click', (e) => { e.stopPropagation(); rec.close(); });
  return rec;
}
