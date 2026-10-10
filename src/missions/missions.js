// Missions (ARCHITECTURE.md §Missions): mission givers (yellow markers at plan POIs of type 'mission'), a data-driven
// step engine (mission_steps.js), 8 missions mixing open-world crime and voxel building (mission_defs.js), pass / fail
// flow with rewards, the Mission Log panel (J), a taxi side job, and the first-play tutorial hint chain.
//
// Public: defs, active (MissionRun|null), completed (Set of ids), best, earned, list(), start(id, opts), abandon(),
// openLog(), closeLog(), toggleLog(), serialize(), deserialize(o), getBlips(out).
// runWhenPaused: only the Mission Log key handling / widgets run while paused; the simulation part needs game.running.
import { MarkerManager, MARKER_COLORS } from './markers.js';
import { MissionHUD } from './mission_hud.js';
import { MissionRun } from './mission_run.js';
import { buildMissionDefs, taxiSideJob } from './mission_defs.js';
import { buildMissionLog } from './mission_log.js';
import { openFallbackModal } from './shop_ui.js';
import { Tutorial } from './tutorial.js';
import { safe, notify, sound, fmtMoney, playerPos, dist2D, HAS_DOM } from './util.js';

const GIVER_R_FOOT = 1.6;
const GIVER_R_CAR = 3.2;

export class Missions {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** Mission definitions (see mission_defs.js), in log order. */
    this.defs = [];
    /** The running story mission (MissionRun) or null. */
    this.active = null;
    /** The running side job (taxi shift) or null. */
    this.side = null;
    /** Ids of passed missions. */
    this.completed = new Set();
    /** Best results per mission id: {time, medal}. */
    this.best = {};
    /** Total money earned from missions. */
    this.earned = 0;
    this.stats = { passed: 0, failed: 0 };
    /** Ids of missions whose starter kit (TNT, rockets, materials...) was handed out; replays only top it up. */
    this.kitsGranted = new Set();
    this.givers = [];
    this.markers = null;
    this.mhud = null;
    this.tutorial = null;
    this._later = [];
    this._log = null;
    this._freezeT = 0;
    this._taxiT = 0;
    this._taxiHintVeh = null;
    this._escCheck = 0;
  }

  init() {
    const g = this.game;
    this.markers = new MarkerManager(g);
    this.mhud = new MissionHUD(g);
    try { this.defs = buildMissionDefs(g); } catch (e) { console.error('[missions] building mission list failed', e); this.defs = []; }
    for (const def of this.defs) {
      const poi = def.giver;
      const y = Number.isFinite(poi.y) ? poi.y : 28;
      const marker = this.markers.marker({ x: poi.x, y, z: poi.z, color: MARKER_COLORS.mission, icon: 'letter', label: def.letter, radius: 1.3, height: 5.5, iconSize: 1.3 });
      this.givers.push({ def, poi, y, marker, armed: true });
    }
    this.tutorial = new Tutorial(g);
    const ev = g.events;
    const route = (name) => ev.on(name, (e) => {
      if (this.active) this.active.onEvent(name, e);
      if (this.side) this.side.onEvent(name, e);
    });
    for (const n of ['blockBroken', 'blockPlaced', 'entityDamaged', 'entityKilled', 'explosion', 'gunfire', 'wantedChanged', 'vehicleEnter', 'vehicleExit', 'pickup']) route(n);
    ev.on('playerDied', () => this._onPlayerDown('You died.'));
    ev.on('busted', () => { this._freezeT = 0; this._onPlayerDown('You got busted.'); });
    ev.on('gameStart', () => { this.tutorial.start(); this._refreshGivers(true); });
    ev.on('playerRespawned', () => this._refreshGivers(true));
    this._refreshGivers();
    this._installDebug();
  }

  // ================================================================================================ public API

  /** Mission summaries for UIs / tests. */
  list() {
    return this.defs.map((d) => ({
      id: d.id, title: d.title, letter: d.letter, reward: d.reward, difficulty: d.difficulty, giver: d.giverName,
      x: d.giver ? +d.giver.x.toFixed(1) : null, z: d.giver ? +d.giver.z.toFixed(1) : null,
      status: this.active && this.active.def === d ? 'active' : this.completed.has(d.id) ? 'completed' : 'available',
      best: this.best[d.id] || null,
    }));
  }

  /** Start a mission by id. opts.force: abandon the current one first. Returns true on success. */
  start(id, opts = {}) {
    const g = this.game;
    const def = this.defs.find((d) => d.id === id);
    if (!def) return false;
    if (this.active) {
      if (!opts.force) return false;
      this._runFailed(this.active, 'Mission abandoned.', 0, true);
    }
    if (this.side) this._endSide();
    this.closeLog();
    const run = new MissionRun(this, def, { replay: this.completed.has(id) });
    this.active = run;
    this._refreshGivers();
    safe(() => g.hud && g.hud.bigMessage && g.hud.bigMessage(def.title.toUpperCase(), def.intro || '', { color: '#f5c518', duration: 3 }));
    sound(g, 'mission_start');
    if (def.brief) notify(g, def.brief, { duration: 7.5, color: '#f5c518' });
    if (run.replay) notify(g, 'Replaying a completed mission: the reward is *halved*.', { duration: 3.5 });
    const p = g.player;
    if (p && !p.inVehicle && p.alive !== false && !p.frozen) { p.frozen = true; this._freezeT = 1.1; }
    g.events.emit('missionStarted', { mission: def.id, title: def.title });
    run.begin();
    return true;
  }

  /** Give up the active mission (counts as a failure). */
  abandon() {
    if (this.active) this._runFailed(this.active, 'Mission abandoned.', 0);
  }

  // ================================================================================================ frame

  update(dt) {
    const g = this.game;
    if (!this.markers) return; // runWhenPaused: the loop runs during loading, before init()
    this.markers.update(dt);
    this.mhud.update();
    this._runLater(dt);
    this._handleLogKeys();
    if (!g.running) return;
    if (this._freezeT > 0) {
      this._freezeT -= dt;
      if (this._freezeT <= 0 && g.player && g.player.alive !== false) g.player.frozen = false;
    }
    try { this.tutorial.update(dt); } catch (e) { /* hints are optional */ }
    if (this.active) this.active.update(dt);
    if (this.side) this.side.update(dt);
    if (!this.active) this._checkGivers();
    this._checkTaxi(dt);
  }

  _checkGivers() {
    const g = this.game;
    const p = g.player;
    if (!p || p.alive === false || !p.position) return;
    const pos = playerPos(g);
    const v = p.inVehicle;
    for (const gv of this.givers) {
      const d = dist2D(pos.x, pos.z, gv.poi.x, gv.poi.z);
      const dy = Math.abs(pos.y - gv.y);
      const r = v ? GIVER_R_CAR : GIVER_R_FOOT;
      gv.marker.active = d < r + 0.6 && dy < 3;
      if (d > r || dy > 3) {
        if (d > r + 1.6 || dy > 4) gv.armed = true;
        continue;
      }
      if (!gv.armed || p.frozen || g.uiOpen) continue;
      if (v && Math.abs(v.speed || 0) > 3) { safe(() => g.hud.prompt('Slow down to start ~y~' + gv.def.title + '~s~.')); continue; }
      const wanted = g.police ? g.police.wanted | 0 : 0;
      if (wanted > 0) { safe(() => g.hud.prompt('Lose the cops before starting a mission.')); continue; }
      if (g.inventory && g.inventory.creative) { safe(() => g.hud.prompt('Switch off ~y~Creative mode~s~ to take jobs.')); continue; }
      gv.armed = false;
      this.start(gv.def.id);
      break;
    }
  }

  _checkTaxi(dt) {
    const g = this.game;
    if (this.active || this.side) { this._taxiT = 0; return; }
    const p = g.player;
    const v = p && p.inVehicle;
    if (v && v.type === 'taxi' && !v.destroyed && p.alive !== false) {
      // no fares while the cops are after you (a running shift that picks up stars carries on)
      if (g.police && (g.police.wanted | 0) > 0) {
        this._taxiT = 0;
        if (this._taxiHintVeh !== v) { this._taxiHintVeh = v; notify(g, 'Lose the cops to start a *taxi shift*.', { duration: 3.5, color: '#ffd23f' }); }
        return;
      }
      this._taxiT += dt;
      if (this._taxiT > 3) { this._taxiT = 0; this._startSide(v); }
    } else { this._taxiT = 0; if (!v) this._taxiHintVeh = null; }
  }

  _startSide(v) {
    const g = this.game;
    const run = new MissionRun(this, taxiSideJob(), { side: true });
    run.vehicle = v;
    this.side = run;
    notify(g, '*Taxi side job*: pick up fares for cash. Get out of the taxi to end your shift.', { duration: 5, color: '#ffd23f' });
    run.begin();
  }

  _endSide(reason) {
    const run = this.side;
    if (!run) return;
    this.side = null;
    run.finished = true;
    run.cleanup(false);
    const fares = run.data.fares || 0, earned = run.data.fareEarnings || 0;
    notify(this.game, (reason ? reason + ' ' : '') + 'Taxi shift over: *' + fares + '* fare' + (fares === 1 ? '' : 's') + ', *' + fmtMoney(earned) + '*.', { duration: 4, color: '#ffd23f' });
  }

  _onPlayerDown(reason) {
    if (this.active) this._runFailed(this.active, reason, 1.3);
    if (this.side) this._endSide();
  }

  // ================================================================================================ pass / fail

  /** Called by a run when its last step completes. */
  _runComplete(run) {
    if (!run || run.finished) return;
    if (run.side) { this._endSide(); return; }
    if (run !== this.active) { run.finished = true; run.cleanup(true); return; }
    run.finished = true;
    const g = this.game;
    const def = run.def;
    // creative mode at any point of the run (free blocks, unlimited TNT, instant mining): no pay, not marked done
    const creative = !!run.usedCreative;
    const first = !creative && !this.completed.has(def.id);
    let reward = def.reward || 0;
    if (typeof def.rewardFor === 'function') { try { reward = def.rewardFor(run); } catch (e) { reward = def.reward || 0; } }
    if (!first) reward = Math.round(reward / 2);
    const total = creative ? 0 : Math.max(0, Math.round(reward + (run.bonus || 0)));
    let note = '';
    if (typeof def.passNote === 'function') { try { note = def.passNote(run) || ''; } catch (e) { note = ''; } }
    if (creative) note = 'Creative mode: no payout';
    let record = false;
    if (!creative && Number.isFinite(run.data.raceTime)) {
      const b = this.best[def.id];
      if (!b || run.data.raceTime < b.time) { record = !!b; this.best[def.id] = { time: +run.data.raceTime.toFixed(2), medal: run.data.medal || null }; }
    }
    run.cleanup(true);
    this.active = null;
    if (total > 0 && g.player && typeof g.player.addMoney === 'function') g.player.addMoney(total, 'mission');
    if (!creative) this.completed.add(def.id);
    this.earned += total;
    this.stats.passed++;
    safe(() => g.hud.bigMessage('MISSION PASSED', fmtMoney(total) + (note ? '   ·   ' + note : ''), { color: '#f5c518', duration: 4.5 }));
    sound(g, 'mission_passed');
    if (creative) notify(g, 'Jobs done in *Creative mode* pay nothing. Switch it off in the pause menu to earn the reward.', { duration: 5 });
    else if (run.bonusNote) notify(g, '*' + run.bonusNote + '* included. Nice work!', { duration: 4, color: '#6ee36a' });
    if (record) notify(g, 'New personal best: *' + (run.data.raceTime || 0).toFixed(2) + ' s*!', { duration: 4, color: '#ffd23f' });
    g.events.emit('missionPassed', { mission: def.id, reward: total, first });
    this._refreshGivers(true);
    if (first && this.completed.size === this.defs.length && this.defs.length) {
      this._later.push({ t: 5.5, fn: () => notify(g, 'You finished *every mission* in Block City! Replays still pay half. Go wild.', { duration: 7, color: '#f5c518' }) });
    }
  }

  /** Called by a run (or the system) to fail the active mission. */
  _runFailed(run, reason, delay = 0, quiet = false) {
    if (!run || run.finished) return;
    if (run.side) { this._endSide(reason); return; }
    run.finished = true;
    const g = this.game;
    run.cleanup(false);
    if (this.active === run) this.active = null;
    // the intro banner must not linger (or still be queued) after an abandon / early fail
    safe(() => g.hud && g.hud.big && typeof g.hud.big.cancel === 'function' && g.hud.big.cancel(run.def.title.toUpperCase()));
    this.stats.failed++;
    const r = reason || 'Mission failed.';
    if (!quiet) {
      const show = () => {
        safe(() => g.hud.bigMessage('MISSION FAILED', r, { color: '#e5484d', duration: 3.5 }));
        sound(g, 'mission_failed');
      };
      if (delay > 0) this._later.push({ t: delay, fn: show }); else show();
    }
    g.events.emit('missionFailed', { mission: run.def.id, reason: r });
    this._refreshGivers(true);
  }

  _refreshGivers(rearmNearby = false) {
    const hide = !!this.active;
    const pos = rearmNearby ? playerPos(this.game) : null;
    for (const gv of this.givers) {
      gv.marker.hidden = hide;
      gv.marker.setDim(this.completed.has(gv.def.id));
      // standing on a giver when a mission ends: step out first before it can start again
      if (pos && dist2D(pos.x, pos.z, gv.poi.x, gv.poi.z) < GIVER_R_CAR + 1) gv.armed = false;
    }
  }

  _runLater(dt) {
    for (let i = this._later.length - 1; i >= 0; i--) {
      const it = this._later[i];
      it.t -= dt;
      if (it.t <= 0) { this._later.splice(i, 1); try { it.fn(); } catch (e) { console.error('[missions] delayed', e); } }
    }
  }

  // ================================================================================================ mission log

  _handleLogKeys() {
    const g = this.game;
    const input = g.input;
    if (!input) return;
    if (this._log) {
      if (this._escCheck > 0) { this._escCheck = 0; if (this._log) this.closeLog(); return; }
      if (input.pressed('missions', true)) { this.closeLog(); return; }
      if (input.pressed('pause', true)) this._escCheck = 1;
      return;
    }
    this._escCheck = 0;
    if (g.running && input.pressed('missions')) this.openLog();
  }

  /** Open the Mission Log panel. */
  openLog() {
    const g = this.game;
    if (this._log || !HAS_DOM || g.state !== 'playing') return false;
    if (g.uiOpen) return false;
    let view;
    try { view = buildMissionLog(this); } catch (e) { console.error('[missions] log', e); return false; }
    g.openUI('missions');
    const onClose = () => this._onLogClosed();
    let rec = null, fallback = false;
    if (g.hud && typeof g.hud.openPanel === 'function') {
      try { rec = g.hud.openPanel('Mission Log', view.el, { width: 760, onClose, uiId: 'missions' }); } catch (e) { rec = null; }
    }
    if (!rec) { rec = openFallbackModal('Mission Log', view.el, { width: 760, onClose }); fallback = true; sound(g, 'ui_open'); }
    this._log = { rec, view, fallback };
    return true;
  }

  closeLog() {
    const l = this._log;
    if (!l) return;
    if (l.rec && typeof l.rec.close === 'function') l.rec.close(); else this._onLogClosed();
  }

  toggleLog() { if (this._log) this.closeLog(); else this.openLog(); }

  _onLogClosed() {
    if (!this._log) return;
    this._log = null;
    this.game.closeUI('missions');
  }

  // ================================================================================================ blips

  getBlips(out) {
    if (this.active) { this.active.blips(out); return; }
    if (this.side) this.side.blips(out);
    // the nearest open job stays pinned to the radar edge so there is always a goal in sight
    const near = this.nearestGiver();
    for (const gv of this.givers) {
      const done = this.completed.has(gv.def.id);
      out.push({ x: gv.poi.x, z: gv.poi.z, color: done ? '#b39a3a' : '#f5c518', icon: 'mission', label: gv.def.letter, size: done ? 4.5 : 5.5, edge: gv === near });
    }
  }

  /** Nearest mission giver ({def, poi, ...}) to `pos` (default: the player) whose mission is not completed, or null. */
  nearestGiver(pos = playerPos(this.game), openOnly = true) {
    if (!pos) return null;
    let best = null, bd = Infinity;
    for (const gv of this.givers) {
      if (openOnly && this.completed.has(gv.def.id)) continue;
      const d = dist2D(pos.x, pos.z, gv.poi.x, gv.poi.z);
      if (d < bd) { bd = d; best = gv; }
    }
    return best;
  }

  // ================================================================================================ save

  serialize() {
    return {
      completed: [...this.completed],
      best: { ...this.best },
      earned: this.earned,
      stats: { ...this.stats },
      tutorial: !!(this.tutorial && this.tutorial.done),
      kits: [...this.kitsGranted],
    };
  }

  deserialize(o) {
    if (!o || typeof o !== 'object') return false;
    const ids = new Set(this.defs.map((d) => d.id));
    this.completed = new Set((Array.isArray(o.completed) ? o.completed : []).filter((id) => typeof id === 'string' && (ids.has(id) || !ids.size)));
    this.best = o.best && typeof o.best === 'object' ? { ...o.best } : {};
    this.earned = Math.max(0, Number(o.earned) || 0);
    if (o.stats) this.stats = { passed: o.stats.passed | 0, failed: o.stats.failed | 0 };
    // older saves have no kit list: a completed mission certainly handed its kit out already
    this.kitsGranted = new Set((Array.isArray(o.kits) ? o.kits : [...this.completed]).filter((id) => typeof id === 'string'));
    if (o.tutorial && this.tutorial) this.tutorial.done = true;
    this._refreshGivers();
    return true;
  }

  // ================================================================================================ debug

  _installDebug() {
    const g = this.game;
    const d = g.debug;
    if (!d) return;
    const self = this;
    /** Start a mission by id (abandons the current one). */
    d.startMission = (id) => self.start(id, { force: true });
    /** Pass the active mission right now. */
    d.completeMission = () => { if (!self.active) return false; self._runComplete(self.active); return true; };
    d.failMission = (reason = 'Debug fail.') => { if (!self.active) return false; self._runFailed(self.active, reason); return true; };
    /** Skip to the next step of the active mission. */
    d.skipStep = () => { if (!self.active) return false; self.active.next(); return self.active ? self.active.stepIndex : 'done'; };
    d.money = (n = 1000) => { const p = g.player; if (!p) return null; if (typeof p.addMoney === 'function') p.addMoney(Number(n) || 0, 'debug'); else p.money += Number(n) || 0; return p.money; };
    d.missions = () => self.list();
    d.missionState = () => {
      const r = self.active || self.side;
      if (!r) return null;
      const st = r.step;
      return {
        id: r.def.id, side: r.side, step: r.stepIndex, type: st && st.spec ? st.spec.type : null, objective: r._objective,
        timeLeft: r.timeLeft !== null ? +r.timeLeft.toFixed(1) : null, elapsed: +r.elapsed.toFixed(1), data: { ...r.data },
        vehicle: r.vehicle ? { type: r.vehicle.type, health: Math.round(r.vehicle.health), x: +r.vehicle.position.x.toFixed(1), z: +r.vehicle.position.z.toFixed(1) } : null,
        stepInfo: st ? {
          got: st.got, total: st.total, n: st.n, count: st.count, placed: st.placed ? st.placed.size : undefined, maxH: st.maxH,
          base: st.base, cur: st.cur, idx: st.idx, points: st.points ? st.points.length : undefined, phase: st.phase, fares: st.fares,
          target: st.target ? { alive: st.target.alive, health: st.target.health } : undefined,
          at: st.p ? { x: st.p.x, y: st.p.y, z: st.p.z } : st.at ? { x: st.at.x, y: st.at.y, z: st.at.z } : undefined,
          area: st.A || st.L || undefined,
        } : null,
      };
    };
    /** Teleport onto a mission giver (by id). */
    d.gotoGiver = (id) => {
      const gv = self.givers.find((x) => x.def.id === id) || self.givers[0];
      if (!gv) return null;
      const yaw = (gv.poi.yaw || 0) + Math.PI;
      d.teleport?.(gv.poi.x + Math.sin(yaw) * 4, gv.y, gv.poi.z + Math.cos(yaw) * 4);
      if (g.cameraRig) g.cameraRig.yaw = yaw + Math.PI;
      return { id: gv.def.id, name: gv.poi.name };
    };
    d.openMissionLog = () => self.openLog();
    d.closeMissionLog = () => { self.closeLog(); return !self._log; };
    d.restartTutorial = () => { self.tutorial.start(true); return true; };
  }
}
