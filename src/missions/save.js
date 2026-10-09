// Save system (ARCHITECTURE.md §Save): localStorage 'blockcity.save.v1' holding money, health, armor, position, yaw,
// inventory, missions, time of day, the safehouse respawn point and the player's world edits (compact run-length
// text, capped at 50k entries). Wanted level is never saved. Autosaves every 60 s while playing (not during missions),
// after a mission is passed, and at the safehouse. init() loads an existing save unless ?newgame=1.
import { encodeEdits, decodeEdits } from './save_codec.js';
import { safe, notify, HAS_DOM, h, uiLayer, injectCss, fmtMoney } from './util.js';

export const SAVE_KEY = 'blockcity.save.v1';
const EDIT_CAP = 50000;
const AUTOSAVE_EVERY = 60;

function storage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export class SaveSystem {
  constructor(game) {
    this.game = game;
    this.autosaveInterval = AUTOSAVE_EVERY;
    this._t = 0;
    /** ms timestamp of the last successful save (this session or loaded). */
    this.lastSave = 0;
    /** true when init() restored a save. */
    this.loaded = false;
    this._editsKey = null;
    this._editsText = null;
    this._editsDirty = true;
    this._ind = null;
    this._indT = 0;
    this._pendingAuto = 0;
    this._loadedInfo = null;
  }

  init() {
    const g = this.game;
    this._installDebug();
    g.events.on('missionPassed', () => { this._pendingAuto = 1.2; });
    const dirty = () => { this._editsDirty = true; };
    g.events.on('blockBroken', dirty);
    g.events.on('blockPlaced', dirty);
    g.events.on('explosion', dirty);
    g.events.on('gameStart', () => {
      if (this.loaded && this._loadedInfo) {
        const i = this._loadedInfo;
        notify(g, 'Welcome back! Save loaded (' + fmtMoney(i.money) + (i.missions ? ', ' + i.missions + (i.missions === 1 ? ' mission' : ' missions') + ' done' : '') + ').', { duration: 4, color: '#3fa9ff' });
      }
    });
    const fresh = g.params && (g.params.get('newgame') === '1' || g.params.get('newgame') === 'true');
    if (!fresh && this.hasSave()) {
      try { this.loaded = this.load(); } catch (e) { console.warn('[save] load failed', e); this.loaded = false; }
    }
  }

  update(dt) {
    this._updateIndicator(dt);
    const g = this.game;
    if (!g.running) return;
    if (this._pendingAuto > 0) {
      this._pendingAuto -= dt;
      if (this._pendingAuto <= 0) this.save({ reason: 'mission' });
    }
    this._t += dt;
    if (this._t >= this.autosaveInterval) {
      this._t = 0;
      if (this._canAutosave()) this.save({ reason: 'auto' });
    }
  }

  _canAutosave() {
    const g = this.game;
    const p = g.player;
    if (!p || p.alive === false) return false;
    if (g.missions && g.missions.active) return false;
    return true;
  }

  // ================================================================================================ public API

  /** True if a save exists in localStorage. */
  hasSave() {
    const s = storage();
    if (!s) return false;
    try { return !!s.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  /** Delete the save (New Game). */
  clear() {
    const s = storage();
    if (!s) return;
    try { s.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    this.lastSave = 0;
  }

  /** Snapshot of the current game as a plain object. */
  snapshot() {
    const g = this.game;
    const p = g.player;
    const data = { v: 1, savedAt: Date.now(), seed: g.seed };
    if (p) {
      let ps = null;
      try { ps = typeof p.serialize === 'function' ? p.serialize() : null; } catch (e) { ps = null; }
      if (!ps) {
        ps = {
          money: p.money | 0, health: Math.round(p.health || 100), armor: Math.round(p.armor || 0),
          position: p.position ? [+p.position.x.toFixed(2), +p.position.y.toFixed(2), +p.position.z.toFixed(2)] : null,
          yaw: +(p.yaw || 0).toFixed(3),
        };
      }
      // dead or inside a vehicle: save a sensible standing spot
      if (p.alive === false) {
        const h = typeof p.nearestPOI === 'function' ? safe(() => p.nearestPOI('hospital'), null) : null;
        if (h) { ps.position = [h.x, h.y, h.z]; ps.yaw = (h.yaw || 0) + Math.PI; }
        ps.health = 100;
      } else if (p.inVehicle && p.inVehicle.position && Array.isArray(ps.position)) {
        ps.position[1] = +(p.inVehicle.position.y + 0.2).toFixed(2);
      }
      data.player = ps;
    }
    if (g.inventory && typeof g.inventory.serialize === 'function') data.inventory = safe(() => g.inventory.serialize(), null);
    if (g.missions && typeof g.missions.serialize === 'function') data.missions = safe(() => g.missions.serialize(), null);
    if (g.shops && g.shops.respawnPoi) data.respawn = { x: g.shops.respawnPoi.x, z: g.shops.respawnPoi.z };
    if (g.sky && Number.isFinite(g.sky.time)) { data.time = +g.sky.time.toFixed(3); if (Number.isFinite(g.sky.dayCount)) data.day = g.sky.dayCount; }
    const ed = this._encodeEdits();
    data.edits = ed.text;
    data.editCount = ed.count;
    return data;
  }

  /** Save now. opts.reason: 'auto' | 'manual' | 'mission' | 'safehouse' | 'sleep'. Returns true on success. */
  save(opts = {}) {
    const s = storage();
    if (!s) return false;
    let data;
    try { data = this.snapshot(); } catch (e) { console.error('[save] snapshot', e); return false; }
    let json = JSON.stringify(data);
    let ok = this._write(s, json);
    if (!ok && data.editCount > 5000) {
      // quota: keep only the most recent edits
      const ed = this._encodeEdits(5000, true);
      data.edits = ed.text; data.editCount = ed.count;
      json = JSON.stringify(data);
      ok = this._write(s, json);
      if (ok) notify(this.game, 'Storage is nearly full: only your latest 5,000 block edits were saved.', { duration: 4, color: '#f5c518' });
    }
    if (!ok) return false;
    this.lastSave = data.savedAt;
    this._t = 0;
    this._showIndicator(opts && opts.reason === 'auto' ? 'Autosaved' : 'Game saved');
    this.game.events.emit('gameSaved', { reason: (opts && opts.reason) || 'manual', bytes: json.length });
    return true;
  }

  _write(s, json) {
    try { s.setItem(SAVE_KEY, json); return true; } catch (e) { return false; }
  }

  _encodeEdits(limit = EDIT_CAP, force = false) {
    const w = this.game.world;
    const edits = w && w.edits;
    if (!edits || !(edits.size > 0)) return { text: '', count: 0 };
    // cheap cache: re-encode only when blocks changed since the last save (events) or the map size differs
    const key = edits.size + '|' + limit;
    if (!force && !this._editsDirty && key === this._editsKey && this._editsText) return this._editsText;
    this._editsDirty = false;
    let res;
    try { res = encodeEdits(edits instanceof Map ? edits : new Map(Object.entries(edits)), limit); } catch (e) { console.error('[save] encode edits', e); res = { text: '', count: 0 }; }
    this._editsKey = key;
    this._editsText = res;
    return res;
  }

  /** Load the save. Returns true on success. */
  load() {
    const s = storage();
    if (!s) return false;
    let raw = null;
    try { raw = s.getItem(SAVE_KEY); } catch (e) { raw = null; }
    if (!raw) return false;
    let d;
    try { d = JSON.parse(raw); } catch (e) { console.warn('[save] corrupt save ignored'); return false; }
    if (!d || typeof d !== 'object' || d.v !== 1) return false;
    const g = this.game;
    const sameWorld = !Number.isFinite(d.seed) || d.seed === g.seed;
    // world edits first (the player must not be placed inside a removed / added block)
    if (sameWorld && d.edits) {
      const flat = decodeEdits(d.edits);
      const w = g.world;
      if (flat.length && w) {
        if (typeof w.applyEdits === 'function') safe(() => w.applyEdits(flat));
        else if (typeof w.setBlock === 'function') for (let i = 0; i + 3 < flat.length; i += 4) safe(() => w.setBlock(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]));
      }
    }
    if (d.inventory && g.inventory && typeof g.inventory.deserialize === 'function') safe(() => g.inventory.deserialize(d.inventory));
    if (d.missions && g.missions && typeof g.missions.deserialize === 'function') safe(() => g.missions.deserialize(d.missions));
    if (Number.isFinite(d.time) && g.sky && typeof g.sky.setTime === 'function') {
      safe(() => g.sky.setTime(d.time));
      if (Number.isFinite(d.day)) g.sky.dayCount = d.day;
    }
    if (sameWorld && d.respawn && g.shops) {
      const poi = (g.shops.list || []).find((x) => x.type === 'safehouse' && Math.hypot(x.x - d.respawn.x, x.z - d.respawn.z) < 2);
      if (poi) { g.shops.respawnPoi = poi.poi; safe(() => g.player && g.player.setRespawnPoint && g.player.setRespawnPoint({ x: poi.poi.x, y: poi.poi.y, z: poi.poi.z, yaw: (poi.poi.yaw || 0) + Math.PI })); }
    }
    const p = g.player;
    if (p && d.player) {
      const ps = { ...d.player };
      if (!sameWorld) delete ps.position;
      if (typeof p.deserialize === 'function') safe(() => p.deserialize(ps));
      else {
        if (Number.isFinite(ps.money)) p.money = ps.money;
        if (Number.isFinite(ps.health)) p.health = ps.health;
        if (Number.isFinite(ps.armor)) p.armor = ps.armor;
        if (Array.isArray(ps.position) && typeof p.teleport === 'function') p.teleport(ps.position[0], ps.position[1], ps.position[2]);
      }
      if (ps.position && Number.isFinite(ps.yaw) && g.cameraRig) g.cameraRig.yaw = ps.yaw;
    }
    // wanted is never saved
    safe(() => g.police && (g.police.wanted | 0) > 0 && g.police.clearWanted && g.police.clearWanted());
    this.lastSave = Number(d.savedAt) || Date.now();
    this._loadedInfo = { money: d.player ? d.player.money | 0 : 0, missions: d.missions && Array.isArray(d.missions.completed) ? d.missions.completed.length : 0 };
    g.events.emit('gameLoaded', { savedAt: this.lastSave });
    return true;
  }

  /** {time, ago, bytes, money, missions} about the stored save (null if none). */
  info() {
    const s = storage();
    if (!s) return null;
    let raw = null;
    try { raw = s.getItem(SAVE_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    const t = Number(d && d.savedAt) || 0;
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    const ago = sec < 10 ? 'just now' : sec < 60 ? sec + ' s ago' : sec < 3600 ? Math.round(sec / 60) + ' min ago' : Math.round(sec / 3600) + ' h ago';
    return {
      time: t, ago, bytes: raw.length, money: d && d.player ? d.player.money | 0 : 0,
      missions: d && d.missions && Array.isArray(d.missions.completed) ? d.missions.completed.length : 0, edits: d ? d.editCount | 0 : 0,
    };
  }

  // ================================================================================================ indicator

  _showIndicator(text) {
    if (!HAS_DOM) return;
    injectCss('save', `
.bcm-saving { position: absolute; right: calc(22px + env(safe-area-inset-right, 0px)); bottom: calc(150px * var(--s, 1) + 30px); z-index: 4;
  display: flex; align-items: center; gap: 10px; padding: 7px 12px 7px 9px; border-radius: 6px; background: rgba(0,0,0,.62);
  font: 700 12px/1 var(--font); letter-spacing: .12em; text-transform: uppercase; color: #e8edf2; opacity: 0; transform: translateY(6px);
  transition: opacity .3s ease, transform .3s ease; pointer-events: none; }
.bcm-saving.on { opacity: 1; transform: none; }
.bcm-saving i { width: 14px; height: 14px; display: block; background: linear-gradient(135deg, #7ec850 0 50%, #866043 50% 100%);
  box-shadow: inset 0 0 0 2px rgba(0,0,0,.35); animation: bcm-spin 1s steps(8) infinite; }
@keyframes bcm-spin { to { transform: rotate(360deg); } }`);
    if (!this._ind) {
      this._ind = h('div', 'bcm-saving', uiLayer());
      h('i', '', this._ind);
      this._indText = h('span', '', this._ind);
    }
    this._indText.textContent = text;
    this._ind.classList.add('on');
    this._indT = 2.2;
  }

  _updateIndicator(dt) {
    if (this._indT > 0) {
      this._indT -= dt;
      if (this._indT <= 0 && this._ind) this._ind.classList.remove('on');
    }
  }

  // ================================================================================================ debug

  _installDebug() {
    const g = this.game;
    const d = g.debug;
    if (!d) return;
    const self = this;
    d.save = () => self.save({ reason: 'manual' });
    d.load = () => self.load();
    d.saveInfo = () => self.info();
    d.clearSave = () => { self.clear(); return !self.hasSave(); };
    d.saveData = () => { const s = storage(); try { return s ? JSON.parse(s.getItem(SAVE_KEY) || 'null') : null; } catch (e) { return null; } };
  }
}
