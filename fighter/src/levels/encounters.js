// Encounters system (game.encounters, FIGHTER.md §11): runs a chapter's rooms.
//
//   startChapter(chapterId, layout)   build the roster, stage room 0 (its first wave already stands in the room,
//                                     dormant, so nothing pops into view when you walk in)
//   getRoster(chapterId)              roster data (rosters.js)
//   reset()                           retry: remove every spawned enemy, reset gates, restage the chapter
// Per fight room: the player walks ~2 m past the entry gate -> gates close (world.setGate), 'roomStarted', the staged
// wave wakes (staggered), further waves walk in from the far door when the floor thins out, and on clear the gates
// open, 'roomCleared' + 'restPoint' fire (deck editing allowed) and the next room is staged.
// Boss room: the boss is staged on its spot; on entry the gates close, 'bossIntro' fires (with its 2-4 lines), the
// camera holds on the boss (cinematic) while it strikes its intro pose, then the lines are queued as blocking
// 'dialogue' (the box freezes the sim; A advances, B skips). The fight starts when the box closes (or after the
// reading time if no blocking box opened). Hitting the boss during the intro skips it, with a remark.
// Boss death -> last words (non-blocking), a short slow-mo, then 'bossDefeated'.
// Every 'dialogue' payload: { speaker, text, mood, duration, block, bark?, bossId?, intro? }.
import { yawTo, makeRng } from '../core/math.js';
import { chapterById, CHAPTERS } from '../data/chapters.js';
import { buildRoster, MAX_ALIVE } from './rosters.js';
import { BOSS_INTROS, BOSS_DEFEAT, BOSS_RUDE, ROOM_LINES, SPEAKERS, lineDuration } from './dialogue.js';

const TRIGGER_DEPTH = 2.0;       // metres past the entry gate before a room locks
const WAVE_DELAY = 0.8;          // pause before the next wave walks in
const SPAWN_GAP = 0.35;          // between two reinforcements
const CLEAR_DELAY = 0.9;         // breath after the last enemy falls
const BOSS_DEFEAT_DELAY = 1.6;   // the boss's death plays out before 'bossDefeated'
const STAGE_ORDER = [0, 1, 2, 3, 4, 7, 5, 6];
const INTRO_POSE = 0.9;          // real seconds the boss poses before the intro lines appear

export class Encounters {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;      // the boss intro sequencer runs on real time (waits while a UI layer is open)
    this.chapterId = null;
    this.chapterIndex = 1;
    this.layout = null;
    this.roster = null;
    /** Runtime room records: { room, def, state, wave, queue, fighters, ... } */
    this.recs = [];
    this.current = 0;
    /** Fighters spawned by encounters (alive or not, until removed). */
    this.spawned = [];
    this.intro = null;
    /** Rest point after a cleared room ({ roomId, x, z }) or null; deck editing is allowed while atRest. */
    this.restPoint = null;
    this.atRest = false;
    this.bossFighter = null;
    this._autoT = 0;
    this._rng = makeRng(4242);
  }

  init() {
    const ev = this.game.events;
    if (ev && typeof ev.on === 'function') {
      ev.on('hit', (e) => this._onHit(e));
      ev.on('fighterDied', (e) => this._onDied(e));
    }
    this._installDebug();
  }

  // ============================================================================================ API

  /** Roster data for a chapter (fresh object). */
  getRoster(chapterId) { return buildRoster(chapterId || this.chapterId || 'laundromat'); }

  /** Start (or restart) a chapter's encounters on a loaded layout. Returns the roster. */
  startChapter(chapterId, layout) {
    this._clear();
    const ch = chapterById(chapterId) || CHAPTERS[0];
    this.chapterId = ch.id;
    this.chapterIndex = ch.index || 1;
    this.layout = layout || this.game.world?.layout || null;
    this.roster = buildRoster(ch.id);
    const seed = parseInt(this.game.params?.get?.('seed') || '', 10);
    this._rng = makeRng(((isFinite(seed) ? seed : 4242) * 31 + this.chapterIndex) >>> 0);
    try { this.game.ai?.setDifficulty?.(this.chapterIndex); } catch (e) { /* ai optional */ }
    const rooms = (this.layout && Array.isArray(this.layout.rooms)) ? this.layout.rooms : [];
    const fights = this.roster.rooms.filter((r) => r.kind === 'fight');
    const boss = this.roster.rooms.find((r) => r.kind === 'boss');
    let fi = 0;
    this.recs = rooms.map((room) => {
      const def = room.kind === 'boss' ? boss : (fights[fi++] || fights[fights.length - 1]);
      return { room, def, state: 'idle', wave: 0, queue: [], queueAt: 0, fighters: [], nextWaveAt: -1, clearAt: -1, boss: null, startedAt: 0 };
    });
    this.current = 0;
    if (this._canSpawn()) this._stage(0);
    return this.roster;
  }

  /** Retry: remove every spawned enemy, reset the chapter's gates and restage it from room 0. */
  reset() {
    const id = this.chapterId;
    this._clear();
    if (!id) return;
    const w = this.game.world;
    let layout = this.layout;
    try {
      // re-loading the loaded chapter only resets its gates (world.js)
      if (w && typeof w.loadChapter === 'function' && w.chapterId === id) layout = w.loadChapter(id) || layout;
    } catch (e) { /* world optional */ }
    this.startChapter(id, layout);
  }

  /** The room currently being fought (record) or null. */
  get activeRoom() {
    const r = this.recs[this.current];
    return r && (r.state === 'active' || r.state === 'clearing' || r.state === 'intro' || r.state === 'boss') ? r.room : null;
  }
  /** True when the deck may be edited (between rooms). */
  canEditDeck() { return this.atRest || !this.activeRoom; }
  /** Living enemies spawned by encounters. */
  enemiesAlive() { let n = 0; for (const f of this.spawned) if (f.alive && !f.removed) n++; return n; }

  // ============================================================================================ loop

  fixedUpdate(dt) {
    const g = this.game;
    const p = g.player;
    if (!this.chapterId) {
      // Flow normally calls startChapter; if it never does (stub flow), start on the loaded world.
      if (p && g.world?.layout && g.state === 'playing') {
        this._autoT += dt;
        if (this._autoT > 0.5) this.startChapter(g.world.chapterId || 'laundromat', g.world.layout);
      }
      return;
    }
    const rec = this.recs[this.current];
    if (!rec || !this._canSpawn()) return;   // combat not ready (stub): rooms stay dormant
    const now = g.time;
    switch (rec.state) {
      case 'staged':
        if (p && p.alive && this._inside(rec.room, p)) this._activate(rec, now);
        break;
      case 'active': this._fightStep(rec, now); break;
      case 'clearing': if (now >= rec.clearAt) this._clearRoom(rec); break;
      case 'defeated':
        if (rec.clearAt >= 0 && now >= rec.clearAt) {
          rec.clearAt = -1;
          rec.state = 'done';
          const b = rec.boss;
          g.events.emit('bossDefeated', { bossId: rec.def.bossId, name: rec.def.name, fighter: b, chapterId: this.chapterId, room: rec.room });
        }
        break;
      default: break;
    }
  }

  /**
   * Real-time part: the boss intro sequencer. The boss strikes its intro pose for a beat, then every line is queued
   * at once (the dialogue box blocks the sim and lets the player advance / skip). The fight starts when the box has
   * closed, or after the lines' reading time if no blocking box ever opened.
   */
  update(dt) {
    const it = this.intro;
    if (!it || this.game.state !== 'playing' || this.game.paused) return;
    const ui = this.game.uiOpen;
    if (!it.emitted) {
      if (ui) return;
      it.t += Math.min(dt, 0.1);
      if (it.t < INTRO_POSE) return;
      it.emitted = true;
      it.t = 0;
      for (let i = 0; i < it.lines.length; i++) {
        const ln = it.lines[i];
        this.game.events.emit('dialogue', { speaker: ln.speaker, text: ln.text, mood: ln.mood, bossId: it.bossId,
          index: i, count: it.lines.length, duration: ln.duration, intro: true, block: true });
      }
      return;
    }
    if (ui) { it.sawUI = true; return; }      // the player is reading
    if (it.sawUI) { this._endIntro(false); return; }
    it.t += Math.min(dt, 0.1);
    if (it.t >= it.total) this._endIntro(false);
  }

  // ============================================================================================ rooms

  _stage(i) {
    const rec = this.recs[i];
    if (!rec || rec.state !== 'idle') return;
    rec.state = 'staged';
    const room = rec.room, def = rec.def;
    if (!def) return;
    if (def.kind === 'boss') {
      const spot = room.bossSpot || room.spawns?.[0] || room.center;
      const face = room.entry || room.gate || room.center;
      rec.boss = this._spawn(rec, { archetype: def.bossId, bossId: def.bossId, name: def.name, health: def.health,
        damageMult: def.damageMult, style: def.style, stance: def.stance }, spot, yawTo(spot.x, spot.z, face.x, face.z), true);
      this.bossFighter = rec.boss;
      return;
    }
    const wave = def.waves[0] || [];
    const spawns = room.spawns && room.spawns.length ? room.spawns : [room.center];
    const face = room.entry || room.gate || room.center;
    for (let k = 0; k < wave.length; k++) {
      const s = spawns[STAGE_ORDER[k % STAGE_ORDER.length] % spawns.length];
      this._spawn(rec, wave[k], s, yawTo(s.x, s.z, face.x, face.z) + (this._rng() - 0.5) * 0.6, true);
    }
    rec.wave = 1;
  }

  _inside(room, p) {
    const w = this.game.world;
    let inRoom;
    if (w && typeof w.roomAt === 'function') {
      const r = w.roomAt(p.position);
      inRoom = !!r && (r === room || r.id === room.id);
    } else {
      inRoom = Math.hypot(p.position.x - room.center.x, p.position.z - room.center.z) < (room.radius || 5);
    }
    if (!inRoom) return false;
    const g = room.gate || room.entry;
    return !g || Math.hypot(p.position.x - g.x, p.position.z - g.z) >= TRIGGER_DEPTH;
  }

  _activate(rec, now) {
    const g = this.game, room = rec.room, def = rec.def;
    this._setGate(room.id, false);
    this.atRest = false;
    this.restPoint = null;
    rec.startedAt = now;
    try { g.ai?.director?.resetStats?.(); } catch (e) { /* ai optional */ }
    if (def.kind === 'boss') {
      rec.state = 'intro';
      g.events.emit('roomStarted', { room, index: room.index, chapterId: this.chapterId, kind: 'boss', bossId: def.bossId });
      this._beginIntro(rec);
      return;
    }
    rec.state = 'active';
    let total = 0;
    for (const w of def.waves) total += w.length;
    g.events.emit('roomStarted', { room, index: room.index, chapterId: this.chapterId, kind: 'fight', waves: def.waves.length, enemies: total });
    // the staged wave notices you, one after the other
    let k = 0, speaker = null;
    for (const f of rec.fighters) {
      if (!f.alive) continue;
      g.ai?.wake?.(f, 0.12 + k * 0.32 + this._rng() * 0.15);
      if (!speaker) speaker = f;
      k++;
    }
    // sometimes somebody has something to say about it
    const lines = ROOM_LINES[this.chapterId];
    if (speaker && lines && this._rng() < 0.55) {
      const said = g.ai?.bark?.(speaker, lines[Math.floor(this._rng() * lines.length)], 'dry');
      if (said === undefined) g.events.emit('dialogue', { speaker: speaker.name, text: lines[0], mood: 'dry', bark: true, block: false, duration: 2.2 });
    }
  }

  _fightStep(rec, now) {
    const def = rec.def;
    let alive = 0;
    for (let i = 0; i < rec.fighters.length; i++) { const f = rec.fighters[i]; if (f.alive && !f.removed) alive++; }
    // next wave once the floor thins out
    if (rec.wave < def.waves.length && !rec.queue.length) {
      if (alive <= def.nextAt) {
        if (rec.nextWaveAt < 0) rec.nextWaveAt = now + WAVE_DELAY;
        else if (now >= rec.nextWaveAt) {
          for (const d of def.waves[rec.wave]) rec.queue.push(d);
          rec.wave++;
          rec.nextWaveAt = -1;
          rec.queueAt = now;
        }
      } else rec.nextWaveAt = -1;
    }
    // reinforcements walk in from the far door, one at a time, never more than MAX_ALIVE on the floor
    if (rec.queue.length && now >= rec.queueAt && alive < MAX_ALIVE) {
      const d = rec.queue.shift();
      const pos = this._reinforcementSpot(rec);
      const p = this.game.player;
      const yaw = p ? yawTo(pos.x, pos.z, p.position.x, p.position.z) : 0;
      const f = this._spawn(rec, d, pos, yaw, false);
      if (f) this.game.events.emit('enemyArrived', { fighter: f, room: rec.room, wave: rec.wave });
      rec.queueAt = now + SPAWN_GAP;
      alive++;
    }
    if (rec.wave >= def.waves.length && !rec.queue.length && alive === 0) {
      rec.state = 'clearing';
      rec.clearAt = now + CLEAR_DELAY;
    }
  }

  _reinforcementSpot(rec) {
    const room = rec.room, p = this.game.player;
    const px = p ? p.position.x : room.center.x, pz = p ? p.position.z : room.center.z;
    const w = this.game.world;
    let best = null, bs = -Infinity;
    const consider = (x, z, bonus) => {
      if (w && typeof w.isWalkable === 'function') { try { if (!w.isWalkable(x, z, 0.4)) return; } catch (e) { /* ignore */ } }
      let s = Math.hypot(x - px, z - pz) + bonus;
      // keep clear of other fighters
      for (const f of this.game.combat?.fighters || []) {
        if (!f.alive) continue;
        const d = Math.hypot(f.position.x - x, f.position.z - z);
        if (d < 1.6) s -= (1.6 - d) * 6;
      }
      s += this._rng() * 0.8;
      if (s > bs) { bs = s; best = { x, z }; }
    };
    if (room.exit) for (const o of [-1.1, 0, 1.1]) consider(room.exit.x + o, room.exit.z, 1.5);
    for (const s of room.spawns || []) consider(s.x, s.z, 0);
    return best || room.spawns?.[0] || room.center;
  }

  _clearRoom(rec) {
    const g = this.game, room = rec.room;
    rec.state = 'cleared';
    this._setGate(room.id, true);
    const spot = room.exit || room.gate || room.center;
    this.restPoint = { roomId: room.id, x: spot.x, z: spot.z };
    this.atRest = true;
    const next = this.recs[this.current + 1] || null;
    g.events.emit('roomCleared', { room, index: room.index, chapterId: this.chapterId, restPoint: this.restPoint, rest: true,
      next: next ? next.room : null, time: +(g.time - rec.startedAt).toFixed(1) });
    g.events.emit('restPoint', { room, position: this.restPoint, chapterId: this.chapterId });
    this.current++;
    this._stage(this.current);
  }

  // ============================================================================================ boss

  _beginIntro(rec) {
    const g = this.game, def = rec.def, boss = rec.boss;
    const id = def.bossId;
    const speaker = SPEAKERS[id] || def.name;
    const lines = (BOSS_INTROS[id] || []).map((l) => ({ speaker, text: l.text, mood: l.mood, duration: lineDuration(l.text) }));
    let total = 0.35;
    for (const l of lines) total += l.duration;
    g.events.emit('bossIntro', { bossId: id, name: def.name, fullName: def.fullName, lines, room: rec.room, fighter: boss,
      chapterId: this.chapterId, duration: total });
    this.intro = { rec, bossId: id, lines, t: 0, total, emitted: false, sawUI: false };
    if (boss) {
      try { g.cameraRig?.cinematic?.(boss, total + INTRO_POSE + 0.3, { height: 1.5 }); } catch (e) { /* camera optional */ }
      try { boss.animator?.playAction?.('intro_' + id, { fade: 0.25, fromCurrent: true }); } catch (e) { /* anim optional */ }
    }
    try { g.audio?.play?.('boss_sting', { volume: 0.9 }); } catch (e) { /* audio optional */ }
    if (!lines.length) this._endIntro(false);
  }

  _endIntro(rude) {
    const it = this.intro;
    if (!it) return;
    this.intro = null;
    const g = this.game, rec = it.rec, boss = rec.boss;
    if (rec.state === 'intro') rec.state = 'boss';
    try { g.cameraRig?.endCinematic?.(); } catch (e) { /* ignore */ }
    if (rude) {
      const l = BOSS_RUDE[it.bossId];
      if (l) g.events.emit('dialogue', { speaker: SPEAKERS[it.bossId] || rec.def.name, text: l.text, mood: l.mood, bossId: it.bossId, duration: lineDuration(l.text), bark: true, block: false });
    }
    if (boss && boss.alive) {
      try { if (!rude && boss.state === 'idle') boss.animator?.stopAction?.(0.2); } catch (e) { /* ignore */ }
      g.ai?.wake?.(boss, rude ? 0 : 0.15);
    }
    g.events.emit('bossFightStart', { bossId: it.bossId, fighter: boss, rude: !!rude, chapterId: this.chapterId });
  }

  // ============================================================================================ events

  _onHit(e) {
    const d = e && e.defender;
    if (!d || d === this.game.player) return;
    if (this.intro && d === this.intro.rec.boss) { this._endIntro(true); return; }
    // a staged enemy got hit before its room started: start it if the player is inside, else just wake it
    const rec = this.recs[this.current];
    if (rec && rec.state === 'staged' && rec.fighters.includes(d)) {
      const p = this.game.player;
      const w = this.game.world;
      const r = p && w && typeof w.roomAt === 'function' ? w.roomAt(p.position) : null;
      if (r && (r === rec.room || r.id === rec.room.id)) this._activate(rec, this.game.time);
      else this.game.ai?.wake?.(d, 0);
    }
  }

  _onDied(e) {
    const f = e && e.fighter;
    if (!f) return;
    for (const rec of this.recs) {
      if (rec.boss !== f || rec.state === 'defeated' || rec.state === 'done') continue;
      if (this.intro && this.intro.rec === rec) this._endIntro(true);
      rec.state = 'defeated';
      rec.clearAt = this.game.time + BOSS_DEFEAT_DELAY;
      const id = rec.def.bossId;
      const l = BOSS_DEFEAT[id];
      if (l) this.game.events.emit('dialogue', { speaker: SPEAKERS[id] || rec.def.name, text: l.text, mood: l.mood, bossId: id, duration: lineDuration(l.text), bark: true, block: false });
      try { if (typeof this.game.slowmo === 'function') this.game.slowmo(0.35, 0.9); } catch (err) { /* ignore */ }
    }
  }

  // ============================================================================================ helpers

  _spawn(rec, d, pos, yaw, dormant) {
    const g = this.game, combat = g.combat;
    if (!combat || typeof combat.spawnFighter !== 'function') return null;
    let f = null;
    try {
      f = combat.spawnFighter({
        team: 'enemy', ai: d.archetype, boss: d.bossId || undefined, name: d.name,
        look: { preset: d.bossId || d.archetype, seed: d.seed || 1 }, style: d.style, health: d.health, damageMult: d.damageMult,
        position: { x: pos.x, z: pos.z }, yaw: yaw || 0, stance: d.stance || undefined,
      });
    } catch (e) { console.error('[encounters] spawn failed', e); return null; }
    if (!f) return null;
    const ai = g.ai;
    try {
      if (ai && !f.ai && typeof ai.attach === 'function') ai.attach(f, d.archetype);
      ai?.configure?.(f, { dormant: !!dormant });
    } catch (e) { console.error('[encounters] ai attach failed', e); }
    f.encounter = { chapterId: this.chapterId, roomId: rec.room.id, wave: rec.wave };
    rec.fighters.push(f);
    this.spawned.push(f);
    return f;
  }

  _canSpawn() { const c = this.game.combat; return !!c && typeof c.spawnFighter === 'function'; }

  _setGate(roomId, open) {
    const w = this.game.world;
    try { if (w && typeof w.setGate === 'function') w.setGate(roomId, open); } catch (e) { /* world optional */ }
  }

  /** Remove everything encounters spawned and stop any intro. */
  _clear() {
    const g = this.game;
    if (this.intro) { this.intro = null; try { g.cameraRig?.endCinematic?.(); } catch (e) { /* ignore */ } }
    const combat = g.combat;
    for (const f of this.spawned) {
      if (f.removed) continue;
      try { if (combat && typeof combat.removeFighter === 'function') combat.removeFighter(f); } catch (e) { /* ignore */ }
    }
    this.spawned.length = 0;
    this.recs = [];
    this.current = 0;
    this.restPoint = null;
    this.atRest = false;
    this.bossFighter = null;
    this._autoT = 0;
  }

  // ============================================================================================ debug

  state() {
    return {
      chapterId: this.chapterId, chapterIndex: this.chapterIndex, current: this.current, atRest: this.atRest,
      intro: this.intro ? { bossId: this.intro.bossId, emitted: this.intro.emitted, reading: this.intro.sawUI, lines: this.intro.lines.length } : null,
      rooms: this.recs.map((r) => ({ id: r.room.id, kind: r.room.kind, state: r.state, wave: r.wave,
        waves: r.def?.waves?.length || 0, alive: r.fighters.filter((f) => f.alive && !f.removed).length, queued: r.queue.length })),
    };
  }

  _installDebug() {
    const g = this.game;
    const dbg = g.debug || (g.debug = {});
    const self = this;
    dbg.encounters = this;
    /** Snapshot of the chapter's rooms. */
    dbg.encounterState = () => self.state();
    /**
     * Jump into room i of the current chapter (earlier rooms count as cleared): the player is placed inside and the
     * room starts at once. Starts the chapter on the loaded world first if needed.
     */
    dbg.startRoom = (i = 0) => {
      if (!self.chapterId) self.startChapter(g.world?.chapterId || 'laundromat', g.world?.layout);
      const idx = Math.max(0, Math.min(self.recs.length - 1, i | 0));
      for (let j = 0; j < idx; j++) {
        const r = self.recs[j];
        if (r.state === 'cleared' || r.state === 'done') continue;
        for (const f of r.fighters) if (!f.removed) { try { g.combat.removeFighter(f); } catch (e) { /* ignore */ } }
        r.state = 'cleared';
        self._setGate(r.room.id, true);
      }
      self.current = idx;
      const rec = self.recs[idx];
      if (!rec) return null;
      self._stage(idx);
      const p = g.player || g.debug.spawnPlayer?.({});
      const room = rec.room;
      const e = room.entry || room.gate || room.center;
      const x = e.x + (room.center.x - e.x) * 0.45, z = e.z + (room.center.z - e.z) * 0.45;
      if (p) {
        p.position.set(x, 0, z);
        p.prevPosition?.copy?.(p.position);
        p.yaw = yawTo(x, z, room.center.x, room.center.z); p.prevYaw = p.yaw;
        try { g.cameraRig?.snap?.(); } catch (err) { /* ignore */ }
      }
      if (rec.state === 'staged') self._activate(rec, g.time);
      return self.state();
    };
    /** Kill every living enemy. */
    dbg.killAll = () => {
      let n = 0;
      for (const f of [...(g.combat?.fighters || [])]) {
        if (!f.alive || f === g.player || f.team === 'player') continue;
        if (typeof f.kill === 'function') f.kill(g.player || null); else { f.health = 0; }
        n++;
      }
      return n;
    };
    /** Set the current boss's health to a fraction of its maximum (phase tests). */
    dbg.bossHealth = (frac = 0.45) => {
      const b = self.bossFighter;
      if (!b || !b.alive) return null;
      b.health = Math.max(1, Math.round(b.maxHealth * frac));
      return b.health;
    };
    if (typeof dbg.aiStats !== 'function') dbg.aiStats = () => (g.ai && typeof g.ai.stats === 'function' ? g.ai.stats() : null);
  }
}
