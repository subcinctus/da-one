// Mission step engine: data-driven steps that a MissionRun executes in order. Each step type is a class with
// start() / update(dt) -> true when complete / onEvent(name, payload) / blips(out) / end(). Steps talk to the
// world only through `run` helpers (markers, objective, waypoint, tracker, spawning) so cleanup is automatic.
//
//   gotoMarker      { at, radius, text, vehicle: undefined|'any'|'mission'|false(on foot), stop, color, label }
//   enterVehicle    { vehicle: 'mission'|'any'|<type>, text }
//   deliverVehicle  { at, radius, minHealth, text }
//   collectItems    { items: [{x,y,z,label}], text }
//   destroyBlocks   { lot: {x0,z0,x1,z1}, y0, y1, fraction, text }
//   mineBlocks      { ids: [], count, hints: [{x,y,z,id}], text }
//   killTarget      { at, spawn(run) -> {target, guards}, text }
//   evadeWanted     { level, text }
//   placeBlocks     { area: {x0,z0,x1,z1,y0}, count, bonusHeight, bonus, text }
//   raceCheckpoints { points: [{x,y,z,yaw,radius}], gold, silver, timeLimit, text }
//   taxiFares       { count, side }
import * as THREE from 'three';
import { BLOCKS, B } from '../world/blocks.js';
import { MARKER_COLORS, glowSprite } from './markers.js';
import { fmtClock, fmtMoney, fmtMinSec, planOf, safe, sound, dist2D, districtName } from './util.js';

class Step {
  constructor(run, spec) {
    this.run = run;
    this.spec = spec || {};
    this.game = run.game;
    this.t = 0;
    this._gated = false;
  }

  text(fallback = '') {
    const t = this.spec.text;
    if (typeof t === 'function') { try { return t(this.run, this); } catch (e) { return fallback; } }
    return t || fallback;
  }

  /** Resolve a position spec (object or function). */
  pos(at) {
    const p = typeof at === 'function' ? at(this.run) : at;
    return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
  }

  start() { this.run.objective(this.text()); }
  update() { return false; }
  onEvent() {}
  blips() {}
  end() {}

  /**
   * Vehicle requirement gate. Returns true when satisfied; otherwise swaps the objective to "get back in" and
   * points the waypoint at the vehicle until it is satisfied again.
   */
  gate(mode, restore) {
    const run = this.run;
    const pl = this.game.player;
    let ok = true, msg = null, wp = null;
    if (mode === 'mission') {
      const v = run.vehicle;
      if (v && !v.destroyed && pl && pl.inVehicle !== v) { ok = false; msg = 'Get back in the ~b~' + run.vehicleName() + '~s~.'; wp = v.position; }
    } else if (mode === 'any') {
      if (pl && !pl.inVehicle) { ok = false; msg = run.vehicle && !run.vehicle.destroyed ? 'Get in the ~b~' + run.vehicleName() + '~s~.' : 'Get a ~b~vehicle~s~.'; wp = run.vehicle && !run.vehicle.destroyed ? run.vehicle.position : null; }
    } else if (mode === false) {
      if (pl && pl.inVehicle) { ok = false; msg = 'Get out of the vehicle.'; }
    }
    if (!ok) {
      if (!this._gated) { this._gated = true; run.objective(msg); }
      if (wp) run.waypoint(wp);
      return false;
    }
    if (this._gated) { this._gated = false; if (restore) restore(); else run.objective(this.text()); }
    return true;
  }
}

// ================================================================================================ gotoMarker

class GotoMarker extends Step {
  start() {
    const p = this.pos(this.spec.at);
    this.p = p;
    if (!p) return;
    const r = this.spec.radius || 2.5;
    this.marker = this.run.marker({ x: p.x, y: Number.isFinite(p.y) ? p.y : 28, z: p.z, color: this.spec.color || MARKER_COLORS.objective, radius: Math.max(1.2, r * 0.8), height: r > 4 ? 6 : 4.5, icon: this.spec.icon || null, label: this.spec.label || '' });
    this.run.objective(this.text());
    this.run.waypoint(p);
  }

  update(dt) {
    this.t += dt;
    if (!this.p) return true;
    if (!this.gate(this.spec.vehicle, () => { this.run.objective(this.text()); this.run.waypoint(this.p); })) return false;
    const pp = this.run.playerPos();
    if (!pp) return false;
    const d = dist2D(pp.x, pp.z, this.p.x, this.p.z);
    const dy = Math.abs(pp.y - (Number.isFinite(this.p.y) ? this.p.y : pp.y));
    if (this.marker) this.marker.active = d < (this.spec.radius || 2.5) + 1;
    if (d < (this.spec.radius || 2.5) && dy < (this.spec.dy || 4.5)) {
      const v = this.game.player && this.game.player.inVehicle;
      if (this.spec.stop && v && Math.abs(v.speed || 0) > 4) { this.run.prompt('Slow down to stop in the marker.'); return false; }
      return true;
    }
    return false;
  }

  blips(out) {
    if (!this.p || this._gated) return;
    out.push({ x: this.p.x, z: this.p.z, color: this.spec.blipColor || '#f5c518', shape: 'dot', size: 7, edge: true, label: this.spec.label });
  }

  end() {
    this.run.removeItem(this.marker);
    this.run.waypoint(null);
  }
}

// ================================================================================================ enterVehicle

class EnterVehicle extends Step {
  start() {
    this.run.objective(this.text());
    this._wpT = 0;
  }

  update(dt) {
    this.t += dt;
    const pl = this.game.player;
    const mode = this.spec.vehicle || 'any';
    const v = pl && pl.inVehicle;
    const run = this.run;
    if (mode === 'mission') {
      const mv = run.vehicle;
      if (!mv) return true;
      this._wpT -= dt;
      if (this._wpT <= 0) { this._wpT = 1; run.waypoint(mv.position); }
      return v === mv;
    }
    if (mode === 'any') return !!v;
    if (v && v.type === mode) { run.vehicle = v; v.persistent = true; run.ownVehicle(v); return true; }
    return false;
  }

  end() { this.run.waypoint(null); }
}

// ================================================================================================ deliverVehicle

class DeliverVehicle extends Step {
  start() {
    this.p = this.pos(this.spec.at);
    const r = this.spec.radius || 4;
    if (this.p) this.marker = this.run.marker({ x: this.p.x, y: this.p.y || 28, z: this.p.z, color: MARKER_COLORS.objective, radius: r * 0.85, height: 5 });
    this.run.objective(this.text());
    this.run.waypoint(this.p);
    this.warn = [0.8, 0.65];
    this.min = Number.isFinite(this.spec.minHealth) ? this.spec.minHealth : 0;
  }

  update(dt) {
    this.t += dt;
    const run = this.run;
    const v = run.vehicle;
    if (!v || v.destroyed || v.removed) return false; // the run fails on its own
    const hp = Math.max(0, v.health || 0) / Math.max(1, v.maxHealth || 1);
    if (this.min > 0) {
      if (hp < this.min) { run.fail('The ' + run.vehicleName() + ' is too damaged.'); return false; }
      while (this.warn.length && hp < this.warn[0]) {
        const w = this.warn.shift();
        if (w > this.min) run.notify('Careful! The ' + run.vehicleName() + ' is at *' + Math.round(hp * 100) + '%*. Below ' + Math.round(this.min * 100) + '% the deal is off.', { color: '#f5c518', duration: 3.5 });
      }
      run.track({ title: run.def.title, rows: [{ label: 'Condition', value: Math.round(hp * 100) + '%', progress: hp, mark: this.min, color: hp > this.min + 0.2 ? '#6ee36a' : hp > this.min + 0.08 ? '#f5c518' : '#ff5a4f' }] });
    }
    if (!this.gate('mission', () => { run.objective(this.text()); run.waypoint(this.p); })) return false;
    if (!this.p) return true;
    const pp = v.position;
    const d = dist2D(pp.x, pp.z, this.p.x, this.p.z);
    if (this.marker) this.marker.active = d < (this.spec.radius || 4) + 1.5;
    if (d < (this.spec.radius || 4) && Math.abs(pp.y - (this.p.y || pp.y)) < 4) {
      if (Math.abs(v.speed || 0) > 4) { run.prompt('Stop the vehicle in the marker.'); return false; }
      return true;
    }
    return false;
  }

  blips(out) {
    if (!this.p || this._gated) return;
    out.push({ x: this.p.x, z: this.p.z, color: '#f5c518', shape: 'dot', size: 7, edge: true });
  }

  end() {
    this.run.removeItem(this.marker);
    this.run.waypoint(null);
    this.run.track(null);
  }
}

// ================================================================================================ collectItems

class CollectItems extends Step {
  start() {
    const run = this.run;
    const items = (typeof this.spec.items === 'function' ? this.spec.items(run) : this.spec.items) || [];
    this.total = items.length;
    this.got = 0;
    this.items = [];
    const pk = this.game.pickups;
    for (const it of items) {
      const rec = { x: it.x, y: Number.isFinite(it.y) ? it.y : 28, z: it.z, done: false, pickup: null, chev: null, label: it.label || '' };
      if (pk && typeof pk.spawn === 'function') {
        rec.pickup = run.spawnPickup('package', { x: rec.x, y: rec.y, z: rec.z }, 1, {
          persistent: true, mission: true, vehicle: true, onCollect: () => { this._got(rec); return true; },
        });
      }
      rec.chev = run.chevron({ color: '#ffd23f', offset: 1.9, scale: 0.7, follow: () => (rec.done ? null : (rec.pickup ? rec.pickup.base : rec)) });
      this.items.push(rec);
    }
    run.objective(this.text());
    this._track();
  }

  _got(rec) {
    if (rec.done) return;
    rec.done = true;
    this.got++;
    this.run.removeItem(rec.chev);
    this.run.flash('Package ' + this.got + '/' + this.total, '#ffd23f');
    if (this.got < this.total) this.run.objective(this.text());
    this._track();
  }

  _track() {
    this.run.track({ title: this.run.def.title, rows: [{ label: 'Packages', value: this.got + ' / ' + this.total, progress: this.total ? this.got / this.total : 1, color: '#ffd23f' }] });
  }

  update(dt) {
    this.t += dt;
    // fallback collection (no pickups system): walk within 1.6 m
    if (!this.game.pickups || typeof this.game.pickups.spawn !== 'function') {
      const pp = this.run.playerPos();
      if (pp) for (const r of this.items) if (!r.done && dist2D(pp.x, pp.z, r.x, r.z) < 1.6 && Math.abs(pp.y - r.y) < 2.5) { sound(this.game, 'checkpoint'); this._got(r); }
    }
    return this.got >= this.total;
  }

  blips(out) {
    const pp = this.run.playerPos();
    let nearest = null, nd = Infinity;
    for (const r of this.items) {
      if (r.done) continue;
      const d = pp ? dist2D(pp.x, pp.z, r.x, r.z) : 0;
      if (d < nd) { nd = d; nearest = r; }
    }
    for (const r of this.items) {
      if (r.done) continue;
      out.push({ x: r.x, z: r.z, color: '#ffd23f', shape: 'square', size: r === nearest ? 6 : 4.5, edge: r === nearest });
    }
  }

  end() {
    for (const r of this.items) {
      this.run.removeItem(r.chev);
      if (r.pickup && !r.done) safe(() => this.game.pickups.remove(r.pickup));
    }
    this.run.track(null);
  }
}

// ================================================================================================ destroyBlocks

class DestroyBlocks extends Step {
  start() {
    const run = this.run;
    const L = this.spec.lot;
    this.L = L;
    this.y0 = Number.isFinite(this.spec.y0) ? this.spec.y0 : 28;
    this.y1 = Number.isFinite(this.spec.y1) ? this.spec.y1 : 95;
    this.frac = this.spec.fraction || 0.35;
    this.base = Number.isFinite(run.data.demoBase) ? run.data.demoBase : this._countNow();
    run.data.demoBase = this.base;
    this.cur = this.base;
    this.scan = null;
    this.scanWait = 0.5;
    this.fence = run.fence({ x0: L.x0 - 0.5, z0: L.z0 - 0.5, x1: L.x1 + 0.5, z1: L.z1 + 0.5, y: this.y0, height: 3, color: MARKER_COLORS.demolition });
    this.cx = (L.x0 + L.x1) / 2; this.cz = (L.z0 + L.z1) / 2;
    run.objective(this.text());
    run.waypoint({ x: this.cx, z: this.cz });
    this._track();
  }

  _countNow() {
    const w = this.game.world;
    if (!w || typeof w.getBlock !== 'function') return 0;
    let n = 0;
    const L = this.L;
    for (let y = this.y0; y <= this.y1; y++) {
      for (let z = L.z0; z < L.z1; z++) {
        for (let x = L.x0; x < L.x1; x++) {
          const id = w.getBlock(x, y, z);
          if (id && BLOCKS[id] && !BLOCKS[id].liquid) n++;
        }
      }
    }
    return n;
  }

  /** Throttled, incremental recount (≤ 6000 voxels per frame, restarts ~2 s after finishing). */
  _scanStep(dt) {
    const w = this.game.world;
    if (!w || typeof w.getBlock !== 'function') return;
    if (!this.scan) {
      this.scanWait -= dt;
      if (this.scanWait > 0) return;
      this.scan = { x: this.L.x0, y: this.y0, z: this.L.z0, n: 0 };
    }
    const s = this.scan, L = this.L;
    let budget = 6000;
    while (budget-- > 0) {
      const id = w.getBlock(s.x, s.y, s.z);
      if (id && BLOCKS[id] && !BLOCKS[id].liquid) s.n++;
      s.x++;
      if (s.x >= L.x1) { s.x = L.x0; s.z++; if (s.z >= L.z1) { s.z = L.z0; s.y++; if (s.y > this.y1) { this.cur = s.n; this.scan = null; this.scanWait = 2; this._track(); return; } } }
    }
  }

  ratio() { return this.base > 0 ? Math.max(0, (this.base - this.cur) / this.base) : 1; }

  _track() {
    const r = this.ratio();
    this.run.track({ title: this.run.def.title, rows: [{ label: 'Demolished', value: Math.round(r * 100) + '% / ' + Math.round(this.frac * 100) + '%', progress: Math.min(1, r / Math.max(0.01, this.frac)), color: r >= this.frac ? '#6ee36a' : '#ff8a3a' }] });
  }

  onEvent(name) {
    // explosions / breaks: rescan soon
    if ((name === 'explosion' || name === 'blockBroken') && !this.scan) this.scanWait = Math.min(this.scanWait, 0.6);
  }

  update(dt) {
    this.t += dt;
    this._scanStep(dt);
    return this.base <= 0 || this.ratio() >= this.frac;
  }

  blips(out) {
    out.push({ x: this.cx, z: this.cz, color: '#ff6a2a', shape: 'square', size: 7, edge: true });
  }

  end() {
    this.run.removeItem(this.fence);
    this.run.waypoint(null);
    this.run.track(null);
  }
}

// ================================================================================================ mineBlocks

class MineBlocks extends Step {
  start() {
    this.ids = this.spec.ids || [B.DIAMOND_ORE];
    this.count = this.spec.count || 3;
    this.n = 0;
    this.hints = (this.spec.hints || []).filter((h) => this.ids.includes(h.id));
    this.near = [];
    this.hintT = 0;
    this.glows = [];
    for (let i = 0; i < 2; i++) {
      const sp = glowSprite('#7ff3ff', 1.6, 0.0);
      sp.material.depthTest = false;
      sp.renderOrder = 20;
      sp.visible = false;
      this.game.scene && this.game.scene.add(sp);
      this.glows.push(sp);
    }
    this.run.objective(this.text());
    this._track();
  }

  _track() {
    this.run.track({ title: this.run.def.title, rows: [{ label: 'Ores mined', value: this.n + ' / ' + this.count, progress: this.n / this.count, color: '#7ff3ff' }] });
  }

  onEvent(name, e) {
    // only natural ores count (player-placed ones carry natural: false; a missing flag counts as natural)
    if (name !== 'blockBroken' || !e || e.byPlayer === false || e.natural === false || !this.ids.includes(e.id)) return;
    this.n++;
    const def = BLOCKS[e.id];
    this.run.flash((def ? def.name : 'Ore') + ' ' + Math.min(this.n, this.count) + '/' + this.count, e.id === B.DIAMOND_ORE ? '#7ff3ff' : '#ffd23f');
    sound(this.game, 'checkpoint');
    if (this.n < this.count) this.run.objective(this.text());
    this._track();
    this.hintT = 0;
  }

  update(dt) {
    this.t += dt;
    this.hintT -= dt;
    const pp = this.run.playerPos();
    if (this.hintT <= 0 && pp) {
      this.hintT = 1;
      const w = this.game.world;
      const live = this.hints.filter((h) => !w || typeof w.getBlock !== 'function' || w.getBlock(h.x, h.y, h.z) === h.id);
      live.sort((a, b) => ((a.x - pp.x) ** 2 + (a.y - pp.y) ** 2 + (a.z - pp.z) ** 2) - ((b.x - pp.x) ** 2 + (b.y - pp.y) ** 2 + (b.z - pp.z) ** 2));
      this.near = live.slice(0, 3);
    }
    // "ore sense": a glint through the rock on the two nearest ores within 28 m
    for (let i = 0; i < this.glows.length; i++) {
      const g = this.glows[i];
      const h = this.near[i];
      const d = h && pp ? Math.hypot(h.x + 0.5 - pp.x, h.y + 0.5 - pp.y, h.z + 0.5 - pp.z) : Infinity;
      g.visible = d < 28;
      if (g.visible) {
        g.position.set(h.x + 0.5, h.y + 0.5, h.z + 0.5);
        g.material.color.set(h.id === B.DIAMOND_ORE ? '#7ff3ff' : h.id === B.GOLD_ORE ? '#ffd23f' : '#ffffff');
        g.material.opacity = (0.35 + 0.25 * Math.sin(this.t * 5 + i)) * Math.min(1, (28 - d) / 8);
      }
    }
    return this.n >= this.count;
  }

  blips(out) {
    this.near.forEach((h, i) => out.push({ x: h.x + 0.5, z: h.z + 0.5, color: h.id === B.DIAMOND_ORE ? '#7ff3ff' : '#ffd23f', shape: 'dot', size: i === 0 ? 5 : 4, edge: i === 0 }));
  }

  end() {
    for (const g of this.glows) { g.removeFromParent(); g.material.dispose(); }
    this.glows = [];
    this.run.track(null);
  }
}

// ================================================================================================ killTarget

class KillTarget extends Step {
  start() {
    this.at = this.pos(this.spec.at);
    this.spawned = false;
    this.alerted = false;
    this.target = null;
    this.guards = [];
    this.run.objective(this.text());
    if (this.at) this.run.waypoint(this.at);
  }

  _spawn() {
    let res = null;
    try { res = this.spec.spawn(this.run); } catch (e) { console.error('[missions] spawn target', e); res = null; }
    this.spawned = true;
    if (!res || !res.target) { this.run.fail('The target never showed up.'); return; }
    this.target = res.target;
    this.guards = res.guards || [];
    this.chev = this.run.chevron({ color: MARKER_COLORS.target, offset: 2.5, follow: () => (this.target && this.target.alive && !this.target.removed ? this.target.position : null) });
  }

  _alert(reason) {
    if (this.alerted) return;
    this.alerted = true;
    const peds = this.game.peds;
    const pl = this.game.player;
    const crew = [this.target, ...this.guards].filter((p) => p && p.alive && !p.removed);
    if (peds && typeof peds.gangAggro === 'function' && this.target) {
      // gangAggro(position, radius, target, only): `only` is a single ped, so aggro each crew member explicitly
      for (const p of crew) safe(() => peds.gangAggro(p.position, 8, pl, p));
    } else for (const p of crew) { p.target = pl; p.hostile = true; }
    this.run.notify(reason || 'They made you! *Take out the leader!*', { color: '#ff5a4f', duration: 3 });
  }

  onEvent(name, e) {
    if (!this.spawned || !e) return;
    const crew = [this.target, ...this.guards];
    if ((name === 'entityDamaged' || name === 'entityKilled') && crew.includes(e.entity)) this._alert();
    if (name === 'gunfire' && e.position && this.target && dist2D(e.position.x, e.position.z, this.target.position.x, this.target.position.z) < 45) this._alert('Shots fired! The gang is on to you.');
  }

  update(dt) {
    this.t += dt;
    const pp = this.run.playerPos();
    if (!this.spawned) {
      if (this.at && pp && dist2D(pp.x, pp.z, this.at.x, this.at.z) < (this.spec.spawnDist || 140)) this._spawn();
      return false;
    }
    const tg = this.target;
    if (!tg) return false;
    if (!tg.alive) {
      this.run.flash('Target eliminated', '#ff5a4f');
      return true;
    }
    if (tg.removed) { this.run.fail('The target got away.'); return false; }
    this.run.waypoint(tg.position);
    if (!this.alerted && pp && dist2D(pp.x, pp.z, tg.position.x, tg.position.z) < 15) this._alert();
    const alive = this.guards.filter((g) => g && g.alive && !g.removed).length;
    const hp = Math.max(0, tg.health || 0) / Math.max(1, tg.maxHealth || 1);
    this.run.track({ title: this.run.def.title, rows: [
      { label: 'Leader', value: Math.round(hp * 100) + '%', progress: hp, color: '#ff5a4f' },
      { label: 'Bodyguards', value: String(alive), color: alive ? '#ffb3ad' : '#9aa4b2' },
    ] });
    return false;
  }

  blips(out) {
    if (!this.spawned) {
      if (this.at) out.push({ x: this.at.x, z: this.at.z, color: '#ff3b30', shape: 'triangle', size: 7, edge: true });
      return;
    }
    const tg = this.target;
    if (tg && tg.alive && !tg.removed) out.push({ x: tg.position.x, z: tg.position.z, color: '#ff3b30', shape: 'triangle', size: 7, edge: true, flash: this.alerted });
    for (const g of this.guards) if (g && g.alive && !g.removed) out.push({ x: g.position.x, z: g.position.z, color: '#ff3b30', shape: 'dot', size: 4 });
  }

  end() {
    this.run.removeItem(this.chev);
    this.run.waypoint(null);
    this.run.track(null);
  }
}

// ================================================================================================ evadeWanted

class EvadeWanted extends Step {
  start() {
    const police = this.game.police;
    this.level = this.spec.level || 2;
    this.noPolice = !police;
    if (police) {
      const w = police.wanted | 0;
      if (w < this.level) {
        if (typeof police.setWanted === 'function') safe(() => police.setWanted(this.level));
        else if (typeof police.addHeat === 'function') safe(() => police.addHeat(this.level, 'mission'));
      }
    }
    this.run.objective(this.text());
  }

  update(dt) {
    this.t += dt;
    if (this.noPolice) return this.t > 1;
    const w = this.game.police.wanted | 0;
    this.run.track({ title: this.run.def.title, rows: [{ label: 'Wanted', value: w > 0 ? '★'.repeat(w) : 'Clear', color: w > 0 ? '#ffd23f' : '#6ee36a' }] });
    return this.t > 1 && w === 0;
  }

  end() { this.run.track(null); }
}

// ================================================================================================ placeBlocks

const SIGN_OFF_T = 2;   // seconds spent outside the plot (2.5 m clear) to sign a finished build off
const IDLE_ARM_T = 8;   // a builder who never steps into the plot arms the sign-off after this long without building

class PlaceBlocks extends Step {
  start() {
    const run = this.run;
    const A = this.spec.area;
    this.A = A;
    this.count = this.spec.count || 40;
    this.bonusH = this.spec.bonusHeight || 8;
    this.placed = new Set();
    this.maxH = 0;
    this.phase = 'build';
    this.outT = 0;
    this.idleT = 0;
    this.armed = false;
    this._finText = null;
    this.fence = run.fence({ x0: A.x0, z0: A.z0, x1: A.x1, z1: A.z1, y: A.y0, height: 2.4, color: MARKER_COLORS.plot });
    this.cx = (A.x0 + A.x1) / 2; this.cz = (A.z0 + A.z1) / 2;
    run.objective(this.text());
    run.waypoint({ x: this.cx, z: this.cz });
    this._track();
  }

  inside(x, z, m = 0) { const A = this.A; return x >= A.x0 - m && x < A.x1 + m && z >= A.z0 - m && z < A.z1 + m; }

  onEvent(name, e) {
    if (!e || (name !== 'blockPlaced' && name !== 'blockBroken')) return;
    if (!this.inside(e.x, e.z) || e.y < this.A.y0 - 1) return;
    const key = e.x + ',' + e.y + ',' + e.z;
    if (name === 'blockPlaced') {
      if (e.byPlayer === false) return;
      this.placed.add(key);
    } else if (!this.placed.delete(key)) return;
    // still building (also from outside the fence): no sign-off yet
    this.idleT = 0;
    this.outT = 0;
    let mh = 0;
    for (const k of this.placed) { const y = +k.split(',')[1]; mh = Math.max(mh, y - this.A.y0 + 1); }
    const grew = mh > this.maxH;
    this.maxH = mh;
    if (grew && mh === this.bonusH) { this.run.flash('Height bonus unlocked!', '#6ee36a'); sound(this.game, 'checkpoint'); }
    this._track();
  }

  _track() {
    const n = this.placed.size;
    this.run.track({ title: this.run.def.title, rows: [
      { label: 'Blocks placed', value: n + ' / ' + this.count, progress: Math.min(1, n / this.count), color: '#6ee36a' },
      { label: 'Height (bonus)', value: this.maxH + ' / ' + this.bonusH, progress: Math.min(1, this.maxH / this.bonusH), color: this.maxH >= this.bonusH ? '#6ee36a' : '#f5c518' },
    ] });
  }

  /** Objective while the structure is complete: bonus offer / how to sign off / signing off. */
  _finishObjective(signing) {
    let t;
    if (signing) t = 'Signing off... (~y~step back in~s~ to keep building)';
    else {
      const how = this.armed ? 'step out of the plot' : 'step into the plot and back out';
      t = this.maxH >= this.bonusH ? 'Great build! ~y~' + how.charAt(0).toUpperCase() + how.slice(1) + '~s~ to sign it off.'
        : 'Nice! Build it ~y~' + this.bonusH + ' blocks tall~s~ for a bonus, or ~y~' + how + '~s~ to finish.';
    }
    if (t !== this._finText) { this._finText = t; this.run.objective(t); }
  }

  update(dt) {
    this.t += dt;
    const run = this.run;
    if (this.phase === 'build' && this.placed.size >= this.count) {
      this.phase = 'finish';
      this.outT = 0;
      this.idleT = 0;
      sound(this.game, 'checkpoint');
      run.flash('Structure complete!', '#6ee36a');
    }
    if (this.phase === 'finish') {
      // The sign-off arms once the player has stood in the plot since the structure was completed (or after a quiet
      // spell without building), so the 40th block placed from outside the fence does not end the job on the spot.
      const pp = run.playerPos();
      if (pp && this.inside(pp.x, pp.z, 0)) this.armed = true;
      this.idleT += dt;
      const ready = this.armed || this.idleT > IDLE_ARM_T;
      if (pp && ready && !this.inside(pp.x, pp.z, 2.5)) {
        this.outT += dt;
        if (this.outT >= SIGN_OFF_T) {
          if (this.maxH >= this.bonusH) { run.bonus += this.spec.bonus || 600; run.bonusNote = 'Height bonus ' + fmtMoney(this.spec.bonus || 600); }
          run.data.builtBlocks = this.placed.size;
          run.data.builtHeight = this.maxH;
          return true;
        }
      } else this.outT = 0;
      this._finishObjective(this.outT > 0);
    }
    return false;
  }

  blips(out) {
    out.push({ x: this.cx, z: this.cz, color: '#46c46f', shape: 'square', size: 7, edge: true });
  }

  end() {
    this.run.removeItem(this.fence);
    this.run.waypoint(null);
    this.run.track(null);
  }
}

// ================================================================================================ raceCheckpoints

class RaceCheckpoints extends Step {
  start() {
    const run = this.run;
    this.points = (typeof this.spec.points === 'function' ? this.spec.points(run) : this.spec.points) || [];
    this.idx = 0;
    this.arches = [];
    this.phase = 'count';
    this.countT = 3.6;
    this.lastShown = null;
    this.raceT = 0;
    this.splits = [];
    this.prev = new THREE.Vector3();
    this.hold = null;
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const next = this.points[i + 1];
      const a = run.arch({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, radius: p.radius || 6, finish: i === n - 1, nextYaw: next ? Math.atan2(next.x - p.x, next.z - p.z) : null });
      a.setState(i === 0 ? 'next' : i === 1 ? 'later' : 'hidden');
      this.arches.push(a);
    }
    run.objective(this.text());
    const v = this.game.player && this.game.player.inVehicle;
    if (v) this.hold = { v, pos: v.position.clone(), yaw: v.yaw };
    this._track();
  }

  _track() {
    const n = this.points.length;
    const rows = [
      { label: 'Checkpoint', value: Math.min(this.idx, n) + ' / ' + n, progress: n ? this.idx / n : 0, color: '#ffd23f' },
      { label: 'Time', value: fmtClock(this.raceT, 1) },
    ];
    if (this.spec.gold) rows.push({ label: 'Gold / Silver', value: fmtClock(this.spec.gold, 0).replace(/\.\d+$/, '') + ' / ' + fmtClock(this.spec.silver, 0).replace(/\.\d+$/, ''), color: this.raceT <= this.spec.gold ? '#ffd23f' : this.raceT <= this.spec.silver ? '#d9dee6' : '#c98b4a' });
    const best = this.run.sys.best && this.run.sys.best[this.run.def.id];
    if (best && best.time) rows.push({ label: 'Best', value: fmtClock(best.time, 2) });
    this.run.track({ title: this.run.def.title, rows });
  }

  update(dt) {
    this.t += dt;
    const run = this.run;
    const pl = this.game.player;
    const v = pl && pl.inVehicle;
    if (this.phase === 'count') {
      this.countT -= dt;
      // hold the car on the line
      if (this.hold && this.hold.v === v && v.position) {
        v.position.x = this.hold.pos.x; v.position.z = this.hold.pos.z;
        if (v.velocity) { v.velocity.x = 0; v.velocity.z = 0; }
        v.speed = 0;
      }
      const show = this.countT > 2.6 ? null : this.countT > 1.6 ? '3' : this.countT > 0.6 ? '2' : this.countT > -0.4 ? '1' : 'GO';
      if (show !== this.lastShown && show) {
        this.lastShown = show;
        run.countdown(show === 'GO' ? 'GO!' : show, show === 'GO');
        sound(this.game, show === 'GO' ? 'checkpoint' : 'ui_click', { volume: show === 'GO' ? 1 : 0.8, pitch: show === 'GO' ? 1.2 : 1 });
      }
      if (show === 'GO') {
        this.phase = 'race';
        run.setTimeLimit(this.spec.timeLimit || null);
        run.objective(this.text());
        if (this.points[0]) run.waypoint(this.points[0]);
        if (v) this.prev.copy(v.position);
      }
      return false;
    }
    this.raceT += dt;
    if (!this.gate('any', () => run.objective(this.text()))) { this._trackT = (this._trackT || 0) - dt; return false; }
    const pos = v ? v.position : run.playerPos();
    if (!pos) return false;
    const cp = this.points[this.idx];
    if (cp) {
      const r = cp.radius || 6;
      if (segPointDist(this.prev.x, this.prev.z, pos.x, pos.z, cp.x, cp.z) < r && Math.abs(pos.y - cp.y) < 7) {
        this.idx++;
        this.splits.push(this.raceT);
        const last = this.idx >= this.points.length;
        sound(this.game, 'checkpoint', { volume: 1, pitch: last ? 1.25 : 1 });
        this.arches[this.idx - 1].setState('hidden');
        if (this.arches[this.idx]) this.arches[this.idx].setState('next');
        if (this.arches[this.idx + 1]) this.arches[this.idx + 1].setState('later');
        if (this.points[this.idx]) run.waypoint(this.points[this.idx]);
        if (last) {
          run.data.raceTime = this.raceT;
          return true;
        }
        run.flash('Checkpoint ' + this.idx + '/' + this.points.length + '   ' + fmtClock(this.raceT, 2), '#ffd23f');
      }
    }
    this.prev.copy(pos);
    this._trackT = (this._trackT || 0) - dt;
    if (this._trackT <= 0) { this._trackT = 0.1; this._track(); }
    return false;
  }

  blips(out) {
    const a = this.points[this.idx], b = this.points[this.idx + 1];
    if (a) out.push({ x: a.x, z: a.z, color: '#f5c518', shape: 'dot', size: 7, edge: true });
    if (b) out.push({ x: b.x, z: b.z, color: '#f5c518', shape: 'dot', size: 4.5 });
  }

  end() {
    for (const a of this.arches) this.run.removeItem(a);
    this.arches = [];
    this.run.waypoint(null);
    this.run.track(null);
  }
}

function segPointDist(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 1e-6 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

// ================================================================================================ taxiFares

/** Random sidewalk spot beside a road whose midpoint lies minD..maxD from (x, z). */
export function curbSpot(plan, x, z, minD, maxD, rnd = Math.random) {
  if (!plan || !plan.roads || !plan.nodes) return null;
  const cands = [];
  for (const r of plan.roads) {
    if (r.kind === 'highway' || r.kind === 'country') continue;
    const a = plan.nodes[r.a], b = plan.nodes[r.b];
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const d = Math.hypot(mx - x, mz - z);
    if (d >= minD && d <= maxD) cands.push({ r, a, b });
  }
  for (let tries = 0; tries < 24 && cands.length; tries++) {
    const c = cands[Math.floor(rnd() * cands.length)];
    const L = Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z);
    if (L < 20) continue;
    const t = 0.25 + rnd() * 0.5;
    const dx = (c.b.x - c.a.x) / L, dz = (c.b.z - c.a.z) / L;
    const side = rnd() < 0.5 ? 1 : -1;
    const rx = -dz * side, rz = dx * side;
    const off = c.r.width / 2 + 1.6;
    const px = c.a.x + dx * L * t + rx * off, pz = c.a.z + dz * L * t + rz * off;
    if (typeof plan.isSidewalk === 'function' && !plan.isSidewalk(px, pz)) continue;
    const cx = c.a.x + dx * L * t + rx * (c.r.width / 2 - 1.8), cz = c.a.z + dz * L * t + rz * (c.r.width / 2 - 1.8);
    const y = typeof plan.surfaceY === 'function' ? plan.surfaceY(px, pz) : 28;
    return { x: px, y, z: pz, curb: { x: cx, y, z: cz }, faceYaw: Math.atan2(-rx, -rz) };
  }
  return null;
}

class TaxiFares extends Step {
  start() {
    this.count = this.spec.count || Infinity;
    this.side = !!this.spec.side;
    this.fares = 0;
    this.earned = 0;
    this.phase = 'seek';
    this.seekT = this.side ? 2.5 : 0.8;
    this.fare = null;
    this.outT = 0;
    this.run.objective(this.side ? null : this.text());
    this._track();
  }

  _track() {
    const rows = [{ label: 'Fares', value: this.fares + (Number.isFinite(this.count) ? ' / ' + this.count : ''), progress: Number.isFinite(this.count) ? this.fares / this.count : null, color: '#ffd23f' }];
    rows.push({ label: 'Earned', value: fmtMoney(this.earned), color: '#6ee36a' });
    if (this.fare && this.phase === 'ride') rows.push({ label: 'Fare clock', value: fmtMinSec(this.fare.timeLeft), color: this.fare.timeLeft < 10 ? '#ff5a4f' : '#ffffff' });
    this.run.track({ title: this.side ? 'Taxi Shift' : this.run.def.title, rows });
  }

  _newFare() {
    const g = this.game;
    const plan = planOf(g);
    const v = this.run.vehicle;
    const from = v ? v.position : this.run.playerPos();
    if (!plan || !from) return false;
    const spot = curbSpot(plan, from.x, from.z, 45, 170);
    if (!spot) return false;
    const fare = { spot, ped: null, marker: null, timeLeft: 0, dest: null, dist: 0, allowed: 0 };
    const peds = g.peds;
    if (peds && typeof peds.spawnPed === 'function') {
      fare.ped = this.run.spawnPed({ x: spot.x, y: spot.y, z: spot.z }, { mood: 'calm', persistent: true, mode: 'guard', yaw: spot.faceYaw });
    }
    fare.marker = this.run.marker({ x: spot.curb.x, y: spot.curb.y, z: spot.curb.z, color: '#3fa9ff', radius: 2.2, height: 3 });
    this.fare = fare;
    this.phase = 'pickup';
    this.run.objective('Pick up the ~b~passenger~s~.');
    this.run.waypoint(spot.curb);
    if (this.side && this.fares === 0) this.run.notify('A fare is waiting nearby. Stop next to the *blue marker*.', { color: '#ffd23f', duration: 4 });
    return true;
  }

  _board() {
    const f = this.fare;
    const g = this.game;
    const plan = planOf(g);
    const v = this.run.vehicle;
    if (f.ped) { this.run.despawnPed(f.ped); f.ped = null; }
    this.run.removeItem(f.marker);
    sound(g, 'car_door', { position: v ? v.position : undefined });
    const dest = curbSpot(plan, v.position.x, v.position.z, 160, 460) || curbSpot(plan, v.position.x, v.position.z, 90, 600);
    if (!dest) { this.phase = 'seek'; this.seekT = 1; return; }
    f.dest = dest;
    f.dist = dist2D(v.position.x, v.position.z, dest.x, dest.z);
    f.allowed = Math.round(f.dist / 10.5 + 22);
    f.timeLeft = f.allowed;
    f.marker = this.run.marker({ x: dest.curb.x, y: dest.curb.y, z: dest.curb.z, color: MARKER_COLORS.objective, radius: 2.6, height: 4.5 });
    const where = districtName(g, dest.x, dest.z) || 'the destination';
    const lines = ['Take me to ' + where + ', and step on it!', where + ', please. I\'m late!', 'Drop me at ' + where + '. Scenic route not included.', 'Get me to ' + where + ' in one piece, okay?'];
    this.run.notify('Passenger: "' + lines[Math.floor(Math.random() * lines.length)] + '"', { duration: 4, color: '#ffd23f' });
    this.run.objective('Drive the passenger to ~y~' + where + '~s~.');
    this.run.waypoint(dest.curb);
    this.run.setStepTimer(f.timeLeft);
    this.phase = 'ride';
  }

  _arrive() {
    const f = this.fare;
    const g = this.game;
    const v = this.run.vehicle;
    const base = 20 + f.dist * 0.18;
    const speedBonus = Math.max(0, f.timeLeft) * 1.5;
    const tip = f.timeLeft > f.allowed * 0.45 ? Math.round((base + speedBonus) * 0.25) : 0;
    const pay = Math.round(base + speedBonus + tip);
    safe(() => g.player.addMoney(pay, 'taxi'));
    sound(g, 'money');
    sound(g, 'car_door', { position: v ? v.position : undefined });
    this.fares++;
    this.earned += pay;
    this.run.flash('Fare ' + fmtMoney(pay) + (tip ? '  (tip ' + fmtMoney(tip) + ')' : ''), '#6ee36a');
    // passenger walks off
    if (g.peds && typeof g.peds.spawnPed === 'function') {
      const ped = safe(() => g.peds.spawnPed({ x: f.dest.x, y: f.dest.y, z: f.dest.z }, { mood: 'calm', persistent: false }), null);
      void ped;
    }
    this._clearFare();
    this.run.setStepTimer(null);
    this.phase = 'seek';
    this.seekT = 2.5;
    if (!this.side && this.fares < this.count) this.run.objective(this.text());
    this._track();
  }

  _clearFare() {
    const f = this.fare;
    if (!f) return;
    this.run.removeItem(f.marker);
    if (f.ped) this.run.despawnPed(f.ped);
    this.fare = null;
    this.run.waypoint(null);
  }

  update(dt) {
    this.t += dt;
    const run = this.run;
    const pl = this.game.player;
    const v = run.vehicle;
    if (!v || v.destroyed) return false; // run handles the failure
    // must stay in the taxi
    if (pl && pl.inVehicle !== v) {
      if (this.side) { this.outT += dt; if (this.outT > 0.5) { this.ended = 'exit'; return true; } return false; }
      if (!this.gate('mission')) return false;
    } else {
      this.outT = 0;
      if (this._gated) {
        this._gated = false;
        if (this.fare && this.phase === 'pickup') { run.objective('Pick up the ~b~passenger~s~.'); run.waypoint(this.fare.spot.curb); }
        else if (this.fare && this.phase === 'ride') { run.objective('Drive the passenger to ~y~' + (districtName(this.game, this.fare.dest.x, this.fare.dest.z) || 'the destination') + '~s~.'); run.waypoint(this.fare.dest.curb); }
        else run.objective(this.side ? null : this.text());
      }
    }
    const speed = Math.abs(v.speed || 0);
    if (this.phase === 'seek') {
      if (this.fares >= this.count) return true;
      this.seekT -= dt;
      if (this.seekT <= 0 && !this._newFare()) this.seekT = 2;
    } else if (this.phase === 'pickup') {
      const f = this.fare;
      if (f.ped && (!f.ped.alive || f.ped.removed)) {
        run.notify('The fare is gone. Finding another one...', { color: '#ff5a4f' });
        this._clearFare(); this.phase = 'seek'; this.seekT = 2;
        return false;
      }
      const d = dist2D(v.position.x, v.position.z, f.spot.curb.x, f.spot.curb.z);
      if (f.marker) f.marker.active = d < 4;
      if (d < 6.5) {
        if (speed < 2.2) this._board();
        else run.prompt('Stop to let the passenger in.');
      }
    } else if (this.phase === 'ride') {
      const f = this.fare;
      f.timeLeft -= dt;
      if (f.timeLeft <= 0) {
        run.notify('Passenger: "Forget it, I\'ll walk!" *No fare.*', { color: '#ff5a4f', duration: 3.5 });
        if (!this.side) { run.fail('The passenger gave up on you.'); return false; }
        this._clearFare();
        run.setStepTimer(null);
        this.phase = 'seek';
        this.seekT = 2;
        return false;
      }
      const d = dist2D(v.position.x, v.position.z, f.dest.curb.x, f.dest.curb.z);
      if (f.marker) f.marker.active = d < 4;
      if (d < 7) {
        if (speed < 2.5) this._arrive();
        else run.prompt('Stop to drop off the passenger.');
      }
    }
    this._trackT = (this._trackT || 0) - dt;
    if (this._trackT <= 0) { this._trackT = 0.25; this._track(); }
    return false;
  }

  blips(out) {
    const f = this.fare;
    if (!f || this._gated) return;
    if (this.phase === 'pickup') out.push({ x: f.spot.curb.x, z: f.spot.curb.z, color: '#3fa9ff', shape: 'dot', size: 6.5, edge: true });
    else if (this.phase === 'ride' && f.dest) out.push({ x: f.dest.curb.x, z: f.dest.curb.z, color: '#f5c518', shape: 'dot', size: 7, edge: true });
  }

  end() {
    this._clearFare();
    this.run.setStepTimer(null);
    this.run.track(null);
    this.run.data.fares = this.fares;
    this.run.data.fareEarnings = this.earned;
  }
}

export const STEP_TYPES = {
  gotoMarker: GotoMarker,
  enterVehicle: EnterVehicle,
  deliverVehicle: DeliverVehicle,
  collectItems: CollectItems,
  destroyBlocks: DestroyBlocks,
  mineBlocks: MineBlocks,
  killTarget: KillTarget,
  evadeWanted: EvadeWanted,
  placeBlocks: PlaceBlocks,
  raceCheckpoints: RaceCheckpoints,
  taxiFares: TaxiFares,
};

class NoopStep extends Step {
  start() {}
  update() { return true; }
}

/** Instantiate a step from its spec ({type, ...}). Unknown types complete immediately. */
export function makeStep(run, spec) {
  const Cls = STEP_TYPES[spec && spec.type];
  if (!Cls) return new NoopStep(run, {});
  return new Cls(run, spec);
}
