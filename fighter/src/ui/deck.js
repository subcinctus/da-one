// Combat deck editor (Absolver): 4 stances x (main, alt). Two tabs:
//   DECK  the 8 slots laid out like the stance quadrant (front up, right lead right). A on a slot opens a picker of
//         learned moves that start in that stance (moves being learned show their progress). X swaps main / alt.
//   FLOW  the deck as a graph: each slotted move is an arrow from its start stance to its end stance, so you can see
//         how strings route around the quadrants; plus your main-attack strings and the library's showcase routes.
// A turntable preview plays the focused move, or the whole string chained exactly like combat (hold, skip, blend).
import { Screen } from './screen.js';
import { h, esc, sfx, stanceIcon, stanceArrow } from './dom.js';
import { G, hint } from './glyphs.js';
import { MovePreview } from './preview.js';
import { STYLES, STANCE_INFO } from '../data/stances.js';
import { isLearnedId } from '../game/progress.js';
import * as MV from '../combat/moves/index.js';

const ORDER = ['FL', 'FR', 'BL', 'BR'];   // quadrant reading order (front row on top, left lead on the left)
const NODE = { FL: [110, 108], FR: [290, 108], BL: [110, 292], BR: [290, 292] };
const PROPS = {
  break: ['Guard break', 'Breaks guard and pierces absorb', '<path d="M3 3h10v5c0 3-2.5 5-5 6-2.5-1-5-3-5-6z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 3 6.5 7.5h3L7.5 12" fill="none" stroke="currentColor" stroke-width="1.3"/>'],
  stop: ['Stop', 'Interrupts the opponent\'s startup and stuns longer', '<path d="M5.5 2h5l3.5 3.5v5L10.5 14h-5L2 10.5v-5z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.6"/>'],
  double: ['Double', 'Two hit windows', '<path d="M3 4l4 4-4 4M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  charge: ['Charge', 'Hold to charge: more damage, guard break at full charge', '<path d="M3 13h2V9H3zM7 13h2V6H7zM11 13h2V3h-2z" fill="currentColor"/>'],
  duck: ['Duck', 'Ducks under high attacks during startup', '<path d="M2 4h12" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5"/><path d="M8 6v7M5 10l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  jump: ['Jump', 'Hops over low attacks during startup', '<path d="M2 13h12" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5"/><path d="M8 11V3M5 6l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  strafe: ['Strafe', 'Sidesteps thrusts and verticals during startup', '<path d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4"/>'],
  knockdown: ['Knockdown', 'Puts the opponent on the floor', '<path d="M2 14h12" stroke="currentColor" stroke-width="1.3"/><path d="M4 3l7 7M11 5v5H6" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
};
const HEIGHT = { high: 'High', mid: 'Mid', low: 'Low' };
const PATH = { horizontal: 'Horizontal', vertical: 'Vertical', thrust: 'Thrust' };
const WEIGHT_N = { light: 1, medium: 2, heavy: 3 };

const weightBars = (w) => { const n = WEIGHT_N[w] || 1; return `<span class="ls-wt" title="${esc(w)}"><i class="${n >= 1 ? 'on' : ''}"></i><i class="${n >= 2 ? 'on' : ''}"></i><i class="${n >= 3 ? 'on' : ''}"></i></span>`; };
const propIcons = (m) => {
  const ks = Object.keys(m.props || {}).filter((k) => m.props[k] && PROPS[k]);
  return ks.length ? `<span class="ls-props">${ks.map((k) => `<span class="ls-prop" title="${esc(PROPS[k][0])}"><svg viewBox="0 0 16 16">${PROPS[k][2]}</svg></span>`).join('')}</span>` : '';
};
const ms = (s) => `${Math.round((+s || 0) * 1000)}<small style="opacity:.6"> ms</small>`;

export class DeckScreen extends Screen {
  constructor(menus, opts = {}) {
    super(menus, { id: 'deck', uiId: 'deck' });
    this.opts = opts;
    this.tab = opts.tab === 'flow' ? 'flow' : 'deck';
    this.mode = 'grid';
    this.pick = null;          // { st, kind }
    this.stringMode = false;   // preview the focused move's main string instead of the move alone
    this.focusMove = null;
    this.focusRoute = null;
    this.preview = menus.preview || (menus.preview = new MovePreview(this.game));
  }

  // ---------------------------------------------------------------------------------------------- data

  get moves() { return (this.game.combat && this.game.combat.MOVES) || MV.MOVES || {}; }
  move(id) { return id ? this.moves[id] || null : null; }
  get progress() { return this.game.flow ? this.game.flow.progress : null; }

  /** The deck being edited (flow progress deck, else the player's). */
  get deck() {
    const p = this.progress;
    if (p && p.deck) return p.deck;
    const pl = this.game.player;
    if (pl && pl.deck) return pl.deck;
    if (!this._fallbackDeck) this._fallbackDeck = JSON.parse(JSON.stringify(MV.STARTER_DECK || {}));
    return this._fallbackDeck;
  }

  learned(id) {
    const p = this.progress;
    if (p) return isLearnedId(p, id) || this._inDeck(id);
    return true;
  }
  _inDeck(id) { const d = this.deck; for (const st of ORDER) if (d[st] && (d[st].main === id || d[st].alt === id)) return true; return false; }

  /** Player-library moves starting in a stance. */
  movesFrom(st) {
    const out = [];
    for (const m of Object.values(this.moves)) if (m && m.start === st && !m.boss && !m.focus && m.keys) out.push(m);
    return out;
  }

  /** `first` followed by main attacks along the flow (a full string, max 3). */
  mainString(first) {
    const out = [];
    let m = first;
    const d = this.deck;
    while (m && out.length < 3) {
      out.push(m);
      const nxt = d[m.end] ? this.move(d[m.end].main) : null;
      m = nxt;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- render

  render() {
    const p = this.progress;
    const style = STYLES[(p && p.style) || (this.game.player && this.game.player.style) || 'forsaken'];
    const el = h('div', 'ls-screen ls-dim ls-deck');
    el.innerHTML = `<div class="ls-page"><header>
        <div><div class="ls-kick">${this.opts.atRest === false ? 'Debug' : 'Rest point'}</div><h2 class="ls-h2">Combat Deck</h2></div>
        <div class="ls-tabs">${G('tabPrev')}<span class="ls-tab" data-action="tab:deck">Deck</span><span class="ls-tab" data-action="tab:flow">Flow</span>${G('tabNext')}</div>
        <div class="right">${esc(style.name)} · ${esc(style.ability)}</div></header>
      <div class="body"><div class="colA"></div><div class="ls-preview"><div class="top"></div><div class="cap"></div></div><div class="colC ls-det"></div></div></div>
      <div class="ls-hintbar"></div>`;
    this.$A = el.querySelector('.colA');
    this.$C = el.querySelector('.colC');
    this.$prev = el.querySelector('.ls-preview');
    this.$prevTop = el.querySelector('.ls-preview .top');
    this.$prevCap = el.querySelector('.ls-preview .cap');
    this.$hints = el.querySelector('.ls-hintbar');
    this.$tabs = el.querySelectorAll('.ls-tab');
    return el;
  }

  onMount() {
    this.preview.onStep = (i, m) => {
      if (!this.$prevTop) return;
      const n = this.preview.seq.length;
      this.$prevTop.innerHTML = n > 1 ? `<span style="color:var(--muted)">${i + 1} / ${n}</span>&nbsp; ${esc(m.name)}` : '';
    };
    this.preview.attach(this.$prev);
    this._draw();
  }

  onUnmount() {
    this.preview.onStep = null;
    this.preview.detach();
    const fl = this.game.flow;
    if (fl && typeof fl.onDeckClosed === 'function') fl.onDeckClosed(this.deck);
  }

  _draw(focusKey) {
    for (const t of this.$tabs) t.classList.toggle('on', t.dataset.action === 'tab:' + this.tab);
    this.nav.current = null;
    if (this.tab === 'flow') this._drawFlow();
    else if (this.mode === 'pick') this._drawPicker();
    else this._drawGrid();
    this._drawHints();
    this.refreshGlyphs();
    const el = (focusKey && this.el.querySelector(`[data-nav][data-key="${focusKey}"]`)) || this._defaultFocus();
    this.nav.focus(el, true);
  }

  _defaultFocus() {
    if (this.tab === 'flow') return this.$C.querySelector('[data-nav]');
    if (this.mode === 'pick') return this.$A.querySelector('[data-nav].eqd') || this.$A.querySelector('[data-nav]');
    const st = (this.game.player && this.game.player.stance) || 'FR';
    return this.$A.querySelector(`[data-key="${st}:main"]`) || this.$A.querySelector('[data-nav]');
  }

  _drawHints() {
    let s;
    if (this.tab === 'flow') s = hint('navigate', 'Strings') + hint('tabNext', 'Deck') + hint('back', 'Close');
    else if (this.mode === 'pick') s = hint('confirm', 'Equip') + hint('menuY', this.stringMode ? 'Preview move' : 'Preview string') + hint('back', 'Cancel');
    else s = hint('confirm', 'Change') + hint('menuX', 'Swap main / alt') + hint('menuY', this.stringMode ? 'Preview move' : 'Preview string') + hint('back', 'Close');
    this.$hints.innerHTML = s;
  }

  _slotHTML(m, kind) {
    const act = kind === 'main' ? 'light' : 'heavy';
    if (!m) return `${G(act)}<div><div class="nm" style="color:var(--muted)">Empty</div><div class="meta">${kind === 'main' ? 'Main' : 'Alternate'}</div></div>`;
    return `${G(act)}<div style="min-width:0"><div class="nm">${esc(m.name)}</div>
      <div class="meta">${stanceArrow(m.start, m.end)}${weightBars(m.weight)}<span>${HEIGHT[m.height] || ''}</span>${propIcons(m)}</div></div>`;
  }

  _drawGrid() {
    const d = this.deck;
    const cur = this.game.player && this.game.player.stance;
    let s = '<div class="ls-stgrid">';
    for (const st of ORDER) {
      s += `<div class="ls-stb${st === cur ? ' cur' : ''}"><h3>${stanceIcon(st, true)}${esc(STANCE_INFO[st].name)}</h3>`;
      for (const kind of ['main', 'alt']) {
        const m = this.move(d[st] && d[st][kind]);
        s += `<div class="ls-slot" data-nav data-key="${st}:${kind}">${this._slotHTML(m, kind)}</div>`;
      }
      s += '</div>';
    }
    s += '</div>';
    s += `<div style="margin-top:1.4em;color:var(--muted);font-size:.8em;line-height:1.55;max-width:34em">Every attack ends in a stance. The next attack comes from that stance's slots, so each move you place decides where your strings travel.</div>`;
    this.$A.innerHTML = s;
    for (const el of this.$A.querySelectorAll('.ls-slot')) {
      const [st, kind] = el.dataset.key.split(':');
      el._act = () => this._openPicker(st, kind);
      el._focus = () => this._showMove(this.move(d[st] && d[st][kind]), { st, kind });
    }
  }

  _openPicker(st, kind) {
    this.mode = 'pick';
    this.pick = { st, kind };
    this._draw();
  }

  _drawPicker() {
    const { st, kind } = this.pick;
    const d = this.deck;
    const curId = d[st] && d[st][kind];
    const otherId = d[st] && d[st][kind === 'main' ? 'alt' : 'main'];
    const all = this.movesFrom(st);
    const learnPts = (this.progress && this.progress.learn) || {};
    const learned = all.filter((m) => this.learned(m.id));
    const learning = all.filter((m) => !this.learned(m.id) && (learnPts[m.id] || 0) > 0).sort((a, b) => (learnPts[b.id] / b.learn) - (learnPts[a.id] / a.learn));
    const unseen = all.length - learned.length - learning.length;
    let s = `<div class="ls-pickhead">${stanceIcon(st, true)}${esc(STANCE_INFO[st].name)} · ${kind === 'main' ? 'Main' : 'Alternate'} slot ${G(kind === 'main' ? 'light' : 'heavy')}</div>`;
    for (const m of learned) {
      const tag = m.id === curId ? '<span class="eq">Equipped</span>' : m.id === otherId ? `<span class="eq" style="color:var(--muted)">${kind === 'main' ? 'Alt' : 'Main'} · swap</span>` : '';
      s += `<div class="ls-pick${m.id === curId ? ' eqd' : ''}" data-nav data-key="pick:${m.id}"><div style="min-width:0"><div class="nm">${esc(m.name)}</div>
        <div class="meta">${stanceArrow(m.start, m.end)}${weightBars(m.weight)}<span>${HEIGHT[m.height] || ''}</span>${propIcons(m)}</div></div>${tag}</div>`;
    }
    for (const m of learning) {
      const v = learnPts[m.id] || 0, max = Math.max(1, m.learn || 1), on = Math.round((v / max) * 10);
      let ticks = ''; for (let i = 0; i < 10; i++) ticks += `<i class="${i < on ? 'on' : ''}"></i>`;
      s += `<div class="ls-pick locked" data-nav data-key="pick:${m.id}"><div style="min-width:0"><div class="nm">${esc(m.name)}</div>
        <div class="meta">${stanceArrow(m.start, m.end)}${weightBars(m.weight)}<span>Learning ${Math.round(v)} / ${max}</span></div></div>
        <div class="lp"><div class="ls-ticks">${ticks}</div></div></div>`;
    }
    if (unseen > 0) s += `<div style="margin-top:1em;color:var(--muted);font-size:.78em;letter-spacing:.06em">${unseen} more ${unseen === 1 ? 'attack starts' : 'attacks start'} in this stance. Block, parry, absorb or avoid them in a fight to learn them.</div>`;
    this.$A.innerHTML = s;
    for (const el of this.$A.querySelectorAll('.ls-pick')) {
      const id = el.dataset.key.slice(5);
      const m = this.move(id);
      el._focus = () => this._showMove(m, null);
      el._act = () => this._equip(m);
    }
  }

  _equip(m) {
    if (!m) return;
    if (!this.learned(m.id)) {
      sfx(this.game, 'ui_back');
      this._toast('Not learned yet', `Defend against ${m.name} in a fight to learn it`);
      return;
    }
    const { st, kind } = this.pick;
    const d = this.deck;
    if (!d[st]) d[st] = { main: null, alt: null };
    const other = kind === 'main' ? 'alt' : 'main';
    if (d[st][other] === m.id) d[st][other] = d[st][kind];
    d[st][kind] = m.id;
    this._apply();
    this.mode = 'grid';
    const key = `${st}:${kind}`;
    this.pick = null;
    this._draw(key);
  }

  _swap(st) {
    const d = this.deck;
    if (!d[st]) return;
    const a = d[st].main; d[st].main = d[st].alt; d[st].alt = a;
    this._apply();
    const key = this.nav.current && this.nav.current.dataset.key;
    this._draw(key);
    sfx(this.game, 'ui_select');
  }

  _apply() {
    const d = this.deck;
    const fl = this.game.flow;
    if (fl && typeof fl.setDeck === 'function') fl.setDeck(d);
    else { const pl = this.game.player; if (pl && typeof pl.setDeck === 'function') pl.setDeck(d); }
  }

  _toast(text, sub) {
    const hud = this.game.hud;
    if (hud && typeof hud.toast === 'function') hud.toast(text, { kind: 'warn', label: 'Deck', sub, ms: 2400 });
  }

  // ---------------------------------------------------------------------------------------------- details + preview

  _showMove(m, slot) {
    this.focusMove = m;
    const C = this.$C;
    if (!m) {
      C.innerHTML = `<div class="nm">Empty slot</div><div class="ds">Choose an attack that starts in ${slot ? esc(STANCE_INFO[slot.st].name) : 'this stance'}.</div>`;
      this.preview.play([]);
      this.$prevCap.textContent = '';
      return;
    }
    const d = this.deck;
    const next = d[m.end] || {};
    const nm = this.move(next.main), na = this.move(next.alt);
    const props = Object.keys(m.props || {}).filter((k) => m.props[k] && PROPS[k]);
    const learnPts = (this.progress && this.progress.learn) || {};
    const known = this.learned(m.id);
    const chainStrike = Math.max(0, (m.startup || 0) - (m.chainIn || 0));
    C.innerHTML = `<div class="nm">${esc(m.name)}</div><div class="ds">${esc(m.desc || '')}</div>
      <div class="tags"><span class="tag">${weightBars(m.weight)}${esc(m.weight)}</span><span class="tag">${HEIGHT[m.height] || ''}</span><span class="tag">${PATH[m.path] || ''}</span></div>
      <div class="route">${stanceArrow(m.start, m.end)}</div>
      <div class="plist"><div>${G('light')} <span>then</span> ${esc(nm ? nm.name : '—')}</div><div>${G('heavy')} <span>or</span> ${esc(na ? na.name : '—')}</div></div>
      ${props.length ? `<div class="plist">${props.map((k) => `<div><span class="ls-prop"><svg viewBox="0 0 16 16">${PROPS[k][2]}</svg></span>${esc(PROPS[k][0])}<span>· ${esc(PROPS[k][1])}</span></div>`).join('')}</div>` : ''}
      <div class="ls-fd">
        <div><span>Startup</span><b>${ms(m.startup)}</b></div><div><span>Damage</span><b>${Math.round(m.damage || 0)}</b></div>
        <div><span>Chained</span><b>${ms(chainStrike)}</b></div><div><span>Stamina</span><b>${Math.round(m.stamina || 0)}</b></div>
        <div><span>Active</span><b>${ms(m.active)}</b></div><div><span>Reach</span><b>${(+m.reach || 0).toFixed(2)}<small style="opacity:.6"> m</small></b></div>
        <div><span>Recovery</span><b>${ms(m.recovery)}</b></div><div><span>Guard dmg</span><b>${Math.round(m.guardDamage || 0)}</b></div>
      </div>
      <div class="learnst${known ? '' : ' no'}">${known ? 'Learned' : `Learning · ${Math.round(learnPts[m.id] || 0)} / ${m.learn || 0}`}</div>`;
    this.refreshGlyphs();
    this._previewFor(m);
  }

  _previewFor(m) {
    if (!m) return;
    const seq = this.stringMode ? this.mainString(m) : [m];
    this.preview.play(seq);
    this.$prevCap.textContent = this.stringMode ? 'String · main attacks' : `${m.start} → ${m.end}`;
    if (seq.length <= 1) this.$prevTop.innerHTML = '';
  }

  // ---------------------------------------------------------------------------------------------- flow tab

  _routes() {
    const out = [];
    const d = this.deck;
    for (const st of ['FR', 'FL', 'BR', 'BL']) {
      const first = this.move(d[st] && d[st].main);
      if (!first) continue;
      const ms3 = this.mainString(first);
      const path = [st, ...ms3.map((m) => m.end)].join(' → ');
      out.push({ key: 'own:' + st, name: `From ${STANCE_INFO[st].name}`, desc: `Main attacks: ${path}`, moves: ms3.map((m) => m.id), own: true });
    }
    const routes = Array.isArray(MV.COMBO_ROUTES) ? MV.COMBO_ROUTES : [];
    for (const r of routes) if (r && Array.isArray(r.moves)) out.push({ key: 'r:' + r.id, name: r.name, desc: r.desc, moves: r.moves, own: false });
    return out;
  }

  _routeInputs(ids) {
    const d = this.deck;
    if (typeof MV.comboRouteInputs === 'function') { try { return MV.comboRouteInputs(ids, d); } catch (e) { /* fallthrough */ } }
    return ids.map((id) => { const m = this.move(id); const s = m && d[m.start]; return s && s.main === id ? 'main' : s && s.alt === id ? 'alt' : null; });
  }

  _drawFlow() {
    this.$A.innerHTML = `<div class="ls-graph">${this._graphSVG(null)}</div>`;
    const routes = this._routes();
    let s = '<div class="ls-pickhead">Strings</div>';
    let own = true;
    for (const r of routes) {
      if (!r.own && own) { own = false; s += '<div class="ls-pickhead" style="margin-top:1.4em">Showcase routes</div>'; }
      const ins = this._routeInputs(r.moves);
      const ok = ins.every(Boolean);
      const steps = r.moves.map((id, i) => {
        const m = this.move(id);
        return `<span class="stp${ins[i] ? '' : ' miss'}">${ins[i] ? G(ins[i] === 'main' ? 'light' : 'heavy') : ''}${esc(m ? m.name : id)}</span>`;
      }).join('<span class="sep">›</span>');
      const missing = r.moves.filter((id, i) => !ins[i]).map((id) => { const m = this.move(id); return m ? `${m.name} (${m.start})` : id; });
      s += `<div class="ls-route" data-nav data-key="${esc(r.key)}"><div class="nm">${esc(r.name)}</div>${r.desc ? `<div class="ds">${esc(r.desc)}</div>` : ''}
        <div class="steps">${steps}</div>${r.own ? '' : `<div class="ok${ok ? '' : ' no'}">${ok ? 'Playable with your deck' : 'Needs ' + esc(missing.join(', '))}</div>`}</div>`;
    }
    this.$C.innerHTML = s;
    for (const el of this.$C.querySelectorAll('.ls-route')) {
      const r = routes.find((x) => x.key === el.dataset.key);
      el._focus = () => this._focusRoute(r);
      el._act = () => this._focusRoute(r, true);
    }
  }

  _focusRoute(r, restart = false) {
    this.focusRoute = r;
    const ms3 = r ? r.moves.map((id) => this.move(id)).filter(Boolean) : [];
    this.$A.innerHTML = `<div class="ls-graph">${this._graphSVG(ms3)}</div>`;
    if (restart) this.preview.seq = [];
    this.preview.play(ms3);
    this.$prevCap.textContent = r ? r.name : '';
  }

  /** The deck as a stance graph (SVG). `hl` = moves of a highlighted route (drawn in gold, numbered). */
  _graphSVG(hl) {
    const d = this.deck;
    const R = 34;
    let edges = '', labels = '';
    const pairCount = {};
    const edge = (m, cls, idx) => {
      const a = NODE[m.start], b = NODE[m.end];
      if (!a || !b) return;
      let path, lx, ly;
      if (m.start === m.end) {
        // self loop, outward from the centre
        const ox = a[0] - 200, oz = a[1] - 200, L = Math.hypot(ox, oz) || 1;
        const ux = ox / L, uz = oz / L;
        const spread = cls === 'alt' ? 0.55 : -0.55;
        const rot = (x, y, ang) => [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)];
        const [d1x, d1y] = rot(ux, uz, spread + 0.45), [d2x, d2y] = rot(ux, uz, spread - 0.45);
        const p0 = [a[0] + d1x * R, a[1] + d1y * R], p3 = [a[0] + d2x * (R + 5), a[1] + d2y * (R + 5)];
        const c1 = [a[0] + d1x * (R + 62), a[1] + d1y * (R + 62)], c2 = [a[0] + d2x * (R + 62), a[1] + d2y * (R + 62)];
        path = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p3[0].toFixed(1)} ${p3[1].toFixed(1)}`;
        const [mx, my] = rot(ux, uz, spread);
        lx = a[0] + mx * (R + 52); ly = a[1] + my * (R + 52);
      } else {
        const key = m.start + m.end;
        const k = pairCount[key] = (pairCount[key] || 0) + 1;
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        const nx = -dy / L, ny = dx / L;
        const bend = 26 + (k - 1) * 26;
        const cx = (a[0] + b[0]) / 2 + nx * bend, cy = (a[1] + b[1]) / 2 + ny * bend;
        const s0x = cx - a[0], s0y = cy - a[1], s0 = Math.hypot(s0x, s0y);
        const e0x = b[0] - cx, e0y = b[1] - cy, e0 = Math.hypot(e0x, e0y);
        const p0 = [a[0] + s0x / s0 * R, a[1] + s0y / s0 * R], p2 = [b[0] - e0x / e0 * (R + 6), b[1] - e0y / e0 * (R + 6)];
        path = `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
        lx = 0.25 * p0[0] + 0.5 * cx + 0.25 * p2[0] + nx * 9; ly = 0.25 * p0[1] + 0.5 * cy + 0.25 * p2[1] + ny * 9;
      }
      edges += `<path class="edge ${cls}" d="${path}" marker-end="url(#ls-ah-${cls.replace(' dim', 'd')})"/>`;
      if (cls.endsWith(' dim')) return;   // a highlighted route only labels its own steps
      const text = idx ? `${idx}. ${m.name}` : m.name;
      labels += `<text class="elbl ${cls}" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${esc(text)}</text>`;
    };
    if (hl && hl.length) {
      for (const st of ORDER) for (const kind of ['main', 'alt']) { const m = this.move(d[st] && d[st][kind]); if (m && !hl.includes(m)) edge(m, kind === 'main' ? 'main dim' : 'alt dim'); }
      hl.forEach((m, i) => edge(m, 'hl', i + 1));
    } else {
      for (const st of ORDER) for (const kind of ['main', 'alt']) { const m = this.move(d[st] && d[st][kind]); if (m) edge(m, kind); }
    }
    let nodes = '';
    for (const st of ORDER) {
      const [x, y] = NODE[st];
      nodes += `<rect class="node" x="${x - 26}" y="${y - 26}" width="52" height="52" transform="rotate(45 ${x} ${y})"/><text class="nlbl" x="${x}" y="${y}">${st}</text>`;
    }
    const mk = (id, col) => `<marker id="ls-ah-${id}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" fill="${col}"/></marker>`;
    return `<svg viewBox="-10 -10 420 440"><defs>${mk('main', 'rgba(244,239,230,.85)')}${mk('alt', '#5fbf9a')}${mk('hl', '#e8b85a')}
      ${mk('maind', 'rgba(244,239,230,.25)')}${mk('altd', 'rgba(95,191,154,.3)')}</defs>
      <style>.edge.dim{opacity:.28}.elbl.dim{opacity:.3}</style>
      <text class="legend" x="200" y="-2" text-anchor="middle">FRONT</text><text class="legend" x="200" y="410" text-anchor="middle">BACK</text>
      ${edges}${nodes}${labels}
      <g transform="translate(70 428)"><path d="M0 0h26" class="edge main"/><text class="legend" x="32" y="0" dominant-baseline="central">MAIN</text>
      <path d="M140 0h26" class="edge alt"/><text class="legend" x="172" y="0" dominant-baseline="central">ALTERNATE</text></g></svg>`;
  }

  // ---------------------------------------------------------------------------------------------- input

  onAction(a) {
    if (a === 'tabPrev' || a === 'tabNext' || a === 'tab:deck' || a === 'tab:flow') {
      const want = a === 'tab:deck' ? 'deck' : a === 'tab:flow' ? 'flow' : this.tab === 'deck' ? 'flow' : 'deck';
      if (want !== this.tab) { this.tab = want; this.mode = 'grid'; this.pick = null; sfx(this.game, 'ui_move'); this._draw(); }
      return true;
    }
    if (a === 'x') {
      if (this.tab === 'deck' && this.mode === 'grid' && this.nav.current) { this._swap(this.nav.current.dataset.key.split(':')[0]); }
      return true;
    }
    if (a === 'y') {
      if (this.tab === 'deck') { this.stringMode = !this.stringMode; this._drawHints(); this.refreshGlyphs(); this._previewFor(this.focusMove); sfx(this.game, 'ui_move'); }
      else if (this.focusRoute) this._focusRoute(this.focusRoute, true);
      return true;
    }
    if (a === 'back' || a === 'deck' || a === 'pause') {
      if (this.mode === 'pick' && a === 'back') {
        const key = `${this.pick.st}:${this.pick.kind}`;
        this.mode = 'grid'; this.pick = null; sfx(this.game, 'ui_back'); this._draw(key);
        return true;
      }
      sfx(this.game, 'ui_back');
      this.close(true);
      return true;
    }
    return super.onAction(a);
  }

  update(dt) { this.preview.update(dt); }
}
