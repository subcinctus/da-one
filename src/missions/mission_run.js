// One running mission: owns its markers, blips, spawned vehicles / peds / pickups, objective, waypoint, timers and
// the current step. Everything it creates is tracked so cleanup() leaves no trace (mission vehicles and peds are
// handed back to their owner systems as non-persistent so they despawn naturally once out of sight).
import { makeStep } from './mission_steps.js';
import { safe, notify, setWaypoint, playerPos } from './util.js';
import { BLOCKS } from '../world/blocks.js';
import { WEAPONS } from '../data/weapons.js';

export class MissionRun {
  constructor(sys, def, opts = {}) {
    this.sys = sys;
    this.game = sys.game;
    this.def = def;
    this.side = !!opts.side;
    this.replay = !!opts.replay;
    this.data = {};
    this.items = new Set();
    this.vehicles = new Set();
    this.peds = new Set();
    this.pickups = new Set();
    this.vehicle = null;             // the mission vehicle (protected: destroyed -> fail)
    this.stepIndex = -1;
    this.step = null;
    this.elapsed = 0;
    this.timeLeft = Number.isFinite(def.timeLimit) ? def.timeLimit : null;
    this.bonus = 0;
    this.bonusNote = '';
    this.finished = false;
    /** Creative mode was on at some point of the run (free blocks / TNT, instant mining): it pays nothing. */
    this.usedCreative = false;
    this._objective = null;
    this._wp = null;
    this._timerSync = 0;
    this._stepTimer = null;
  }

  // ================================================================================================ lifecycle

  begin() {
    this.usedCreative = !!(this.game.inventory && this.game.inventory.creative);
    if (typeof this.def.setup === 'function') {
      try { this.def.setup(this); } catch (e) { console.error('[missions] setup ' + this.def.id, e); }
    }
    if (this.timeLeft !== null) this._syncTimer(true);
    if (!this.finished) this.next();
  }

  next() {
    if (this.finished) return;
    if (this.step) { try { this.step.end(); } catch (e) { console.error('[missions] step end', e); } }
    this.step = null;
    this.stepIndex++;
    const steps = this.def.steps || [];
    if (this.stepIndex >= steps.length) { this.sys._runComplete(this); return; }
    const spec = typeof steps[this.stepIndex] === 'function' ? steps[this.stepIndex](this) : steps[this.stepIndex];
    if (!spec) { this.next(); return; }
    this.step = makeStep(this, spec);
    try { this.step.start(); } catch (e) { console.error('[missions] step start ' + spec.type, e); }
  }

  update(dt) {
    if (this.finished) return;
    this.elapsed += dt;
    if (!this.usedCreative && this.game.inventory && this.game.inventory.creative) {
      this.usedCreative = true;
      if (!this.side) this.notify('*Creative mode* is on: this job will pay *nothing*.', { duration: 4.5, color: '#e5484d' });
    }
    if (this.timeLeft !== null) {
      this.timeLeft -= dt;
      this._timerSync -= dt;
      if (this._timerSync <= 0) this._syncTimer();
      if (this.timeLeft <= 0) { this.fail('You ran out of time.'); return; }
    }
    const v = this.vehicle;
    if (v && !this._vehChev && !v.destroyed) {
      // floating blue arrow over the mission vehicle whenever the player is not driving it
      const pl = this.game.player;
      this._vehChev = this.chevron({ color: '#3fa9ff', offset: 2.2, scale: 0.85, follow: () => (this._showVehicleHint() && pl && pl.inVehicle !== v ? v.position : null) });
    }
    if (v && this.def.protectVehicle !== false && (v.destroyed || (v.removed && !this._vehicleReleased))) {
      this.fail(v.destroyed ? 'The ' + this.vehicleName() + ' was destroyed.' : 'The ' + this.vehicleName() + ' is gone.');
      return;
    }
    if (!this.step) return;
    let done = false;
    try { done = this.step.update(dt); } catch (e) { console.error('[missions] step update', e); done = false; }
    if (done && !this.finished) this.next();
  }

  onEvent(name, payload) {
    if (this.finished || !this.step || typeof this.step.onEvent !== 'function') return;
    try { this.step.onEvent(name, payload); } catch (e) { console.error('[missions] step event', e); }
  }

  blips(out) {
    if (this.finished) return;
    if (this.step) { try { this.step.blips(out); } catch (e) { /* ignore */ } }
    const v = this.vehicle;
    const pl = this.game.player;
    if (v && pl && pl.inVehicle !== v && this._showVehicleHint()) {
      out.push({ x: v.position.x, z: v.position.z, color: '#3fa9ff', icon: 'car', size: 5.5, edge: true });
    }
  }

  /** Should the mission vehicle be highlighted (blip + arrow) right now? */
  _showVehicleHint() {
    const v = this.vehicle;
    if (!v || v.destroyed || v.removed || this.finished || this.def.vehicleBlip === false) return false;
    if (this.def.protectVehicle !== false) return true;
    // loaner vehicles (race): only while the current step asks the player to get in
    const st = this.step;
    return !!(st && st.spec && st.spec.type === 'enterVehicle');
  }

  fail(reason) { this.sys._runFailed(this, reason); }
  pass() { this.sys._runComplete(this); }

  /** Remove everything this run created. passed: the mission was completed. */
  cleanup(passed = false) {
    if (this.step) { try { this.step.end(); } catch (e) { /* ignore */ } this.step = null; }
    for (const it of this.items) safe(() => this.sys.markers.remove(it));
    this.items.clear();
    for (const p of this.pickups) safe(() => this.game.pickups && this.game.pickups.remove(p));
    this.pickups.clear();
    for (const v of this.vehicles) { if (v && !v.removed) v.persistent = false; }
    this.vehicles.clear();
    for (const p of this.peds) { if (p && !p.removed) p.persistent = false; }
    this.peds.clear();
    if (typeof this.def.cleanup === 'function') { try { this.def.cleanup(this, passed); } catch (e) { console.error('[missions] cleanup', e); } }
    if (!this.side || this._objective) this.objective(null);
    this.waypoint(null);
    this.track(null);
    if (this.timeLeft !== null || this._stepTimer !== null) safe(() => this.game.hud && this.game.hud.setTimer && this.game.hud.setTimer(null));
    this.timeLeft = null;
  }

  // ================================================================================================ helpers for steps

  playerPos() { return playerPos(this.game); }

  vehicleName() {
    const v = this.vehicle;
    return (this.def.vehicleName) || (v && v.def && v.def.name) || 'car';
  }

  objective(text) {
    this._objective = text || null;
    safe(() => this.game.hud && this.game.hud.setObjective && this.game.hud.setObjective(text || null));
  }

  waypoint(p) {
    const wp = p && Number.isFinite(p.x) ? { x: p.x, z: p.z } : null;
    const same = wp && this._wp && Math.abs(wp.x - this._wp.x) < 0.5 && Math.abs(wp.z - this._wp.z) < 0.5;
    if (same || (!wp && !this._wp)) return;
    this._wp = wp;
    setWaypoint(this.game, wp);
  }

  prompt(text) { safe(() => this.game.hud && this.game.hud.prompt && this.game.hud.prompt(text)); }
  notify(text, opts) { notify(this.game, text, opts); }
  track(data) { safe(() => this.sys.mhud.setTracker(data)); }
  flash(text, color) { safe(() => this.sys.mhud.flash(text, color)); }
  countdown(text, go) { safe(() => this.sys.mhud.countdown(text, go)); }

  /** Overall mission time limit (seconds) or null. */
  setTimeLimit(sec) {
    this.timeLeft = Number.isFinite(sec) ? sec : null;
    this._syncTimer(true);
  }

  /** A step-level countdown shown on the HUD timer (taxi fare clock); does not fail the mission by itself. */
  setStepTimer(sec) {
    this._stepTimer = Number.isFinite(sec) ? sec : null;
    if (this.timeLeft === null) safe(() => this.game.hud && this.game.hud.setTimer && this.game.hud.setTimer(this._stepTimer));
  }

  _syncTimer(force) {
    this._timerSync = 1;
    const hud = this.game.hud;
    if (!hud || typeof hud.setTimer !== 'function') return;
    if (this.timeLeft === null) { if (force) safe(() => hud.setTimer(null)); return; }
    let cur = null;
    try { cur = typeof hud.timerRemaining === 'function' ? hud.timerRemaining() : null; } catch (e) { cur = null; }
    if (force || cur === null || Math.abs(cur - this.timeLeft) > 0.35) safe(() => hud.setTimer(Math.max(0, this.timeLeft)));
  }

  marker(opts) { const m = this.sys.markers.marker(opts); this.items.add(m); return m; }
  chevron(opts) { const m = this.sys.markers.chevron(opts); this.items.add(m); return m; }
  arch(opts) { const m = this.sys.markers.arch(opts); this.items.add(m); return m; }
  fence(opts) { const m = this.sys.markers.fence(opts); this.items.add(m); return m; }
  removeItem(it) { if (!it) return; this.items.delete(it); safe(() => this.sys.markers.remove(it)); }

  /** Spawn a vehicle owned by this mission (persistent while the mission runs). */
  spawnVehicle(type, x, y, z, yaw, opts = {}) {
    const vs = this.game.vehicles;
    if (!vs || typeof vs.spawn !== 'function') return null;
    let v = null;
    try { v = vs.spawn(type, x, y, z, yaw, { ...opts, persistent: true }); } catch (e) { console.error('[missions] spawn vehicle', e); v = null; }
    if (v) { v.persistent = true; this.vehicles.add(v); }
    return v;
  }

  /** Spawn a vehicle on the road near pos (Vehicles.spawnNear when available). */
  spawnVehicleNear(type, pos, opts = {}) {
    const vs = this.game.vehicles;
    if (!vs) return null;
    let v = null;
    try {
      if (typeof vs.spawnNear === 'function') v = vs.spawnNear(type, pos, { ...opts, persistent: true });
      else if (typeof vs.spawn === 'function') v = vs.spawn(type, pos.x + 4, undefined, pos.z, opts.yaw || 0, { ...opts, persistent: true });
    } catch (e) { console.error('[missions] spawnNear', e); v = null; }
    if (v) { v.persistent = true; this.vehicles.add(v); }
    return v;
  }

  /** Adopt an existing vehicle as mission-owned (released on cleanup). */
  ownVehicle(v) { if (v) this.vehicles.add(v); }

  spawnPed(pos, opts = {}) {
    const peds = this.game.peds;
    if (!peds || typeof peds.spawnPed !== 'function') return null;
    let p = null;
    try { p = peds.spawnPed(pos, { persistent: true, ...opts }); } catch (e) { console.error('[missions] spawn ped', e); p = null; }
    if (p) this.peds.add(p);
    return p;
  }

  despawnPed(p) {
    if (!p) return;
    this.peds.delete(p);
    const peds = this.game.peds;
    if (peds && typeof peds.remove === 'function') safe(() => peds.remove(p));
  }

  spawnPickup(type, pos, amount, opts = {}) {
    const pk = this.game.pickups;
    if (!pk || typeof pk.spawn !== 'function') return null;
    const p = pk.spawn(type, pos, amount, { persistent: true, mission: true, ...opts });
    if (p) this.pickups.add(p);
    return p;
  }

  /**
   * Mission starter kit: handed out in full the first time this mission is started; any later start (replay, retry
   * after abandoning or failing) only tops the player up to the kit amounts, so start / abandon cycles farm nothing.
   */
  kit(list, note) {
    const sys = this.sys;
    const id = this.def.id;
    if (!sys.kitsGranted || !sys.kitsGranted.has(id)) {
      this.give(list, note);
      if (sys.kitsGranted) sys.kitsGranted.add(id);
      return;
    }
    const added = this.giveUpTo(list);
    if (added.length) this.notify('Kit topped up: ' + added.join(', ') + '.', { duration: 4.5, color: '#f5c518' });
  }

  /** Top the inventory up to the listed amounts (blocks: count, weapons: total rounds, tools: owned). Returns labels. */
  giveUpTo(list) {
    const inv = this.game.inventory;
    const added = [];
    if (!inv) return added;
    for (const it of list) {
      try {
        if (it.kind === 'block') {
          const n = (it.count | 0) - (typeof inv.countBlock === 'function' ? inv.countBlock(it.id) : 0);
          if (n > 0 && inv.addBlock(it.id, n) !== false) added.push('*' + n + ' ' + ((BLOCKS[it.id] && BLOCKS[it.id].name) || 'blocks') + '*');
        } else if (it.kind === 'weapon') {
          const w = typeof inv.getWeapon === 'function' ? inv.getWeapon(it.id) : null;
          const name = (WEAPONS[it.id] && WEAPONS[it.id].name) || it.id;
          if (!w) { if (inv.addWeapon(it.id, it.ammo) !== false) added.push('a *' + name + '*'); continue; }
          const n = (it.ammo | 0) - ((w.mag | 0) + (w.reserve | 0));
          if (n > 0 && inv.addWeapon(it.id, n) !== false) added.push('*' + n + ' ' + name + '* ammo');
        } else if (it.kind === 'tool' && !(inv.hasTool && inv.hasTool(it.id))) {
          inv.addItem({ kind: 'tool', id: it.id });
          added.push('a *' + it.id + '*');
        }
      } catch (e) { /* inventory stub */ }
    }
    return added;
  }

  /** Give the player items for the mission (blocks / weapons / tools), with a notification. */
  give(list, note) {
    const inv = this.game.inventory;
    if (!inv) return;
    for (const it of list) {
      try {
        if (it.kind === 'block') inv.addBlock(it.id, it.count);
        else if (it.kind === 'weapon') inv.addWeapon(it.id, it.ammo);
        else if (it.kind === 'tool' && !(inv.hasTool && inv.hasTool(it.id))) inv.addItem({ kind: 'tool', id: it.id });
      } catch (e) { /* inventory stub */ }
    }
    if (note) this.notify(note, { duration: 4.5, color: '#f5c518' });
  }
}
