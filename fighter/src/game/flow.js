// Flow (system game.flow): game flow + progress (FIGHTER.md §9).
//   title -> new game (style select, prologue) / continue / chapter select -> chapter: story card, world, player,
//   encounters -> rooms (rest points between them: deck editor) -> boss intro -> boss -> victory card -> next chapter
//   -> epilogue + credits after the last one.
//   Death (Sifu): deathCounter += 1, age += deathCounter, short aging card, revive where you fell. Age 70 = game over:
//   the chapter restarts at the state it was entered with, plus slack (progress.gameOverRestart: three more deaths
//   always fit). Relief: a fight room cleared without dying in it, and each boss, lower the counter by one. Chapter
//   select replays from the chapter's recorded entry state (age + counter), never better than a game over.
// API: progress, chapterId, showTitle(), quickStart(), newGame(style), continueGame(), playChapter(id),
//   startChapter(id, opts), restartChapter(), revivePlayer(), completeChapter(), ageDamageMult(), ageHealthMult(),
//   canEditDeck(), setDeck(deck), save(), hasSave().
import { CHAPTERS, chapterById } from '../data/chapters.js';
import { STYLES } from '../data/stances.js';
import * as P from './progress.js';
import { agingLine, REST_LINES } from './story.js';
import { roman } from '../ui/dom.js';
import * as MV from '../combat/moves/index.js';

const ORDER = CHAPTERS.map((c) => c.id);
const DEATH_DELAY = 1.7;     // sim seconds of the death clip before the aging card
const VICTORY_DELAY = 1.4;   // sim seconds after 'bossDefeated' (encounters already let the death play) before the card
const REST_CLEAR = 7;        // no enemy within this many metres for a rest point
const PROMPT_REST = { action: 'deck', text: 'Combat deck', sub: 'Rest point' };
const PROMPT_LOCK = { action: 'lock', text: 'Lock on' };

function storage() { try { return window.localStorage || null; } catch (e) { return null; } }
const starterDeck = () => MV.STARTER_DECK || null;
const libMove = (id) => { const t = MV.MOVES; return t && t[id] ? t[id] : null; };
const isPlayerMove = (id) => { const m = libMove(id); return !!(m && !m.boss && !m.focus); };
/** Learned-but-unequipped starter moves (moves library; [] when absent), filtered to real player moves. */
const starterExtra = () => {
  const list = Array.isArray(MV.STARTER_EXTRA) ? MV.STARTER_EXTRA : [];
  return MV.MOVES ? list.filter(isPlayerMove) : list.slice();
};

export class Flow {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    /** Current chapter id (null before the first chapter). */
    this.chapterId = null;
    /** Progress (see progress.js). */
    this.progress = P.newProgress({ starterDeck: starterDeck(), starterExtra: starterExtra() });
    this.layout = null;
    /** 'boot' | 'title' | 'loading' | 'playing' | 'dying' | 'aging' | 'victory' | 'ending' */
    this.phase = 'boot';
    /** True during transitions (menus will not open the pause menu). */
    this.busy = false;
    /** At a rest point: room cleared (or chapter start) and no enemies around. */
    this.restAvailable = false;
    /** quickStart runs (tests) do not write the save. */
    this.ephemeral = false;
    this._hasSave = false;
    this._token = 0;
    this._deathT = -1;
    this._victoryT = -1;
    this._victoryBoss = null;
    this._chapter = { deaths: 0, learned: 0 };
    this._roomDeaths = 0;      // player deaths since the current fight room started (room-clear relief)
    this._lockedOnce = false;
    this._restLine = 0;
    this._showRest = null;
    this._showLock = null;
  }

  init() {
    const g = this.game;
    this._loadSave();
    const ev = g.events;
    ev.on('fighterDied', (e) => {
      const f = e && e.fighter;
      if (!f) return;
      if (f === g.player) this._onPlayerDown();
      else if (f.team !== 'player') this.progress.stats.kills = (this.progress.stats.kills || 0) + 1;
    });
    ev.on('bossDefeated', (e) => this._onBossDefeated(e || {}));
    ev.on('roomStarted', () => { this.restAvailable = false; this._roomDeaths = 0; });
    ev.on('bossIntro', () => { this.restAvailable = false; });
    ev.on('roomCleared', () => {
      this.restAvailable = true;
      // Sifu-style relief: a room cleared without dying in it calms the talisman (counter -1)
      const p = this.progress;
      let sub = '';
      if (this._roomDeaths === 0 && p.deathCounter > 0) {
        p.deathCounter--;
        sub = `Clean room · death counter ${p.deathCounter + 1} → ${p.deathCounter}`;
        g.events.emit('deathCounterRelief', { counter: p.deathCounter, reason: 'room' });
      }
      this._roomDeaths = 0;
      const hud = g.hud;
      if (hud && typeof hud.toast === 'function') {
        hud.toast(REST_LINES[this._restLine++ % REST_LINES.length], { label: 'Room cleared', kind: 'info', ms: 3200, sub });
      }
      this.save();
    });
    ev.on('learned', (e) => {
      if (e && e.moveId) P.addLearned(this.progress, e.moveId);
      this._chapter.learned++;
      this.progress.stats.learnedCount = (this.progress.stats.learnedCount || 0) + 1;
      this.save();
    });
    this._installDebug();
  }

  // ---------------------------------------------------------------------------------------------- save

  /** (Re)load progress from storage (a fresh run when there is no save). */
  _loadSave() {
    const raw = P.readSave(storage());
    this._hasSave = !!raw;
    this.progress = raw
      ? P.sanitizeProgress(raw, {
        starterDeck: starterDeck(), starterExtra: starterExtra(), isMove: MV.MOVES ? isPlayerMove : null,
        startOf: MV.MOVES ? (id) => libMove(id).start : null, chapterIds: ORDER,
      })
      : P.newProgress({ starterDeck: starterDeck(), starterExtra: starterExtra() });
  }

  /** True when a started run exists in storage. */
  hasSave() { return this._hasSave && !!this.progress.started; }

  /** Write progress to localStorage (skipped for quickStart test runs). */
  save() {
    if (this.ephemeral) return false;
    const ok = P.writeSave(storage(), this.progress);
    if (ok) this._hasSave = true;
    return ok;
  }
  /** Alias used by combat/learning.js. */
  saveProgress() { return this.save(); }

  // ---------------------------------------------------------------------------------------------- age (Sifu)

  /** Damage multiplier from the current age (combat reads this). */
  ageDamageMult() { return P.ageDamageMult(this.progress.age); }
  /** Max-health multiplier from the current age (combat reads this). */
  ageHealthMult() { return P.ageHealthMult(this.progress.age); }

  // ---------------------------------------------------------------------------------------------- entry points

  /** Title screen over the live scene. */
  showTitle() {
    const g = this.game;
    this._token++;
    this.phase = 'title';
    this.busy = false;
    this.restAvailable = false;
    this._deathT = this._victoryT = -1;
    g.state = 'title';
    // an ?autostart test run never touched the save: put the real progress back before offering 'Continue'
    if (this.ephemeral) { this.ephemeral = false; this._loadSave(); }
    const m = g.menus;
    if (m && typeof m.closeAll === 'function') m.closeAll();
    if (g.paused) g.setPaused(false);
    this._clearWorldState();
    this._prompts(false);
    if (m && typeof m.showTitle === 'function') m.showTitle();
  }

  /** ?autostart=1: straight into play (chapter / style from the URL), no cards, nothing saved. */
  async quickStart() {
    const g = this.game;
    const params = g.params || new URLSearchParams('');
    const ch = chapterById(params.get('chapter')) || CHAPTERS[0];
    const style = STYLES[params.get('style')] ? params.get('style') : 'forsaken';
    this.ephemeral = true;
    this.progress = P.newProgress({ style, starterDeck: starterDeck(), starterExtra: starterExtra(), chapterId: ch.id });
    g.events.emit('gameStart', { quick: true });
    await this.startChapter(ch.id, { card: false, banner: false });
  }

  /** New run with a defensive style: prologue card, then chapter 1. */
  async newGame(style = 'forsaken') {
    const g = this.game;
    this.ephemeral = false;
    this.progress = P.newProgress({ style, starterDeck: starterDeck(), starterExtra: starterExtra() });
    this.save();
    const token = ++this._token;
    g.events.emit('gameStart', { style });
    const m = g.menus;
    if (m && typeof m.closeAll === 'function') m.closeAll();
    if (m && typeof m.card === 'function') await m.card({ kind: 'premise' });
    if (token !== this._token) return;
    await this.startChapter(ORDER[0]);
  }

  /** Continue the saved run at the start of its chapter (age and entry age kept). */
  async continueGame() {
    this.ephemeral = false;
    this.game.events.emit('gameStart', { resume: true });
    await this.startChapter(this.progress.chapterId || ORDER[0], { resume: true });
  }

  /**
   * Chapter select: replay a chapter from its recorded entry state (lowest entry age and the counter that came with
   * it) when that is younger than now; a replay equals a game over and is never better than one.
   */
  async playChapter(id) {
    const ch = chapterById(id);
    if (!ch) return;
    const p = this.progress;
    const st = P.chapterReplayState(p, ch.id);
    p.age = st.age; p.deathCounter = st.counter;
    this.ephemeral = false;
    this.game.events.emit('gameStart', { chapter: ch.id });
    await this.startChapter(ch.id);
  }

  /**
   * Start a chapter. opts: { card = true (story card), banner = true (chapter title), resume = false (keep the saved
   * entry age) }.
   * Order: story card up -> world.loadChapter -> spawn player -> encounters.startChapter -> card dismissed -> play.
   */
  async startChapter(id, opts = {}) {
    const g = this.game;
    const ch = chapterById(id) || CHAPTERS[0];
    const token = ++this._token;
    this.busy = true;
    this.phase = 'loading';
    this.chapterId = ch.id;
    const p = this.progress;
    if (opts.resume) { p.chapterId = ch.id; p.started = true; } else P.enterChapter(p, ch.id);
    this.save();
    this._chapter = { deaths: 0, learned: 0 };
    this._roomDeaths = 0;
    const m = g.menus;
    if (m && typeof m.closeAll === 'function') m.closeAll();
    if (g.paused) g.setPaused(false);
    const cardP = opts.card !== false && m && typeof m.card === 'function' ? m.card({ kind: 'story', chapterId: ch.id }) : null;
    if (cardP) await new Promise((r) => setTimeout(r, 40));   // let the card paint before the (synchronous) world build
    if (token !== this._token) return;
    await this._setup(ch.id);
    if (token !== this._token) return;
    g.events.emit('chapterStart', { chapterId: ch.id });
    if (cardP) await cardP;
    if (token !== this._token) return;
    this.busy = false;
    const hud = g.hud;
    if (opts.banner !== false && hud && typeof hud.banner === 'function') hud.banner(`Chapter ${roman(ch.index)}`, ch.title, ch.subtitle, 3.4);
  }

  /** Restart the current chapter (fresh roster, same age). */
  restartChapter() { return this.startChapter(this.chapterId || this.progress.chapterId || ORDER[0], { card: false, resume: true }); }

  _clearWorldState() {
    const g = this.game;
    try { if (g.encounters && typeof g.encounters.reset === 'function') g.encounters.reset(); } catch (e) { console.error('[flow] encounters.reset', e); }
    try { if (g.combat && typeof g.combat.clear === 'function') g.combat.clear(); } catch (e) { console.error('[flow] combat.clear', e); }
  }

  async _setup(id) {
    const g = this.game;
    this._clearWorldState();
    let layout = null;
    try {
      layout = g.world && typeof g.world.loadChapter === 'function' ? g.world.loadChapter(id) : null;
      if (layout && typeof layout.then === 'function') layout = await layout;
    } catch (e) { console.error('[flow] world.loadChapter', e); }
    this.layout = layout || null;
    const ps = (layout && layout.playerStart) || { x: 0, z: 0, yaw: 0 };
    const p = this.progress;
    try {
      if (g.combat && typeof g.combat.spawnFighter === 'function') {
        g.combat.spawnFighter({
          team: 'player', look: { preset: 'player' }, deck: p.deck, style: p.style, name: 'You',
          position: { x: +ps.x || 0, z: +ps.z || 0 }, yaw: +ps.yaw || 0,
        });
      }
    } catch (e) { console.error('[flow] spawn player', e); }
    try { if (g.encounters && typeof g.encounters.startChapter === 'function') g.encounters.startChapter(id, layout); } catch (e) { console.error('[flow] encounters.startChapter', e); }
    g.state = 'playing';
    this.phase = 'playing';
    this.restAvailable = true;
    this._deathT = this._victoryT = -1;
    try { if (g.cameraRig && typeof g.cameraRig.snap === 'function') g.cameraRig.snap(); } catch (e) { /* optional */ }
    if (g.input && typeof g.input.clearBuffer === 'function') g.input.clearBuffer();
  }

  // ---------------------------------------------------------------------------------------------- death + aging

  _onPlayerDown() {
    if (this.phase !== 'playing') return;
    this.phase = 'dying';
    this._deathT = DEATH_DELAY;
  }

  async _agePlayer() {
    const g = this.game;
    const token = this._token;
    this.phase = 'aging';
    this.busy = true;
    const p = this.progress;
    const r = P.applyDeath(p);
    this._chapter.deaths++;
    this._roomDeaths++;
    g.events.emit('playerAged', { age: Math.min(P.AGE_MAX, p.age), deaths: p.deaths, counter: p.deathCounter });
    const m = g.menus;
    if (r.gameOver) {
      g.events.emit('gameOver', { chapterId: this.chapterId });
      // back to the chapter's entry state plus slack (three more deaths always fit); applied and saved before the
      // card, so quitting from the card never leaves an age-70 run behind
      const restart = P.applyGameOverRestart(p);
      this.save();
      const ch = chapterById(this.chapterId);
      const replayHint = restart.age >= 55 && !!ch && ch.index > 1;
      if (m && typeof m.card === 'function') {
        await m.card({ kind: 'gameover', from: r.from, to: P.AGE_MAX, counter: r.counter, entryAge: restart.age, entryCounter: restart.counter, replayHint });
      }
      if (token !== this._token) return;
      g.events.emit('playerAged', { age: p.age, deaths: p.deaths, counter: p.deathCounter });
      this.busy = false;
      await this.restartChapter();
      return;
    }
    this.save();
    if (m && typeof m.card === 'function') {
      await m.card({ kind: 'aging', from: r.from, to: r.to, counter: r.counter, deaths: p.deaths, line: agingLine(r.to) });
    }
    if (token !== this._token) return;
    this.revivePlayer();
    this.busy = false;
  }

  /** Stand the player up where they fell (getup), full health for their age; enemies keep their health. */
  revivePlayer() {
    const g = this.game;
    const pl = g.player;
    if (pl) {
      try {
        if (g.combat && typeof g.combat.revive === 'function') g.combat.revive(pl);
        else if (typeof pl.revive === 'function') pl.revive({ healthMult: this.ageHealthMult() });
        else { pl.health = pl.maxHealth; pl.alive = true; pl.state = 'getup'; }
      } catch (e) { console.error('[flow] revive', e); }
    }
    if (this.phase === 'dying' || this.phase === 'aging') this.phase = 'playing';
    this._deathT = -1;
  }

  // ---------------------------------------------------------------------------------------------- victory

  _onBossDefeated(e) {
    if (this.phase === 'victory' || this.phase === 'ending' || this.game.state !== 'playing') return;
    if (this.phase === 'dying') this.revivePlayer();   // traded blows: the living get the win
    this.phase = 'victory';
    this.restAvailable = false;
    this._victoryBoss = e.bossId || (chapterById(this.chapterId) || {}).boss?.id || null;
    this._victoryT = VICTORY_DELAY;
  }

  async _showVictory() {
    const g = this.game;
    const token = this._token;
    this.phase = 'ending';
    this.busy = true;
    const p = this.progress;
    const m = g.menus;
    if (m && typeof m.card === 'function') {
      await m.card({ kind: 'victory', bossId: this._victoryBoss, chapterId: this.chapterId, age: p.age, deaths: this._chapter.deaths, learned: this._chapter.learned });
    }
    if (token !== this._token) return;
    const next = this.completeChapter();
    if (next) { await this.startChapter(next); return; }
    if (m && typeof m.card === 'function') await m.card({ kind: 'epilogue' });
    if (token !== this._token) return;
    if (m && typeof m.openCredits === 'function') await m.openCredits();
    if (token !== this._token) return;
    this.showTitle();
  }

  /** Mark the current chapter complete (talisman calms: death counter -1). Returns the next chapter id or null. */
  completeChapter() {
    const p = this.progress;
    const id = this.chapterId || p.chapterId;
    const next = P.completeChapterProgress(p, id, ORDER);
    p.deathCounter = Math.max(0, (p.deathCounter || 0) - 1);
    this.game.events.emit('chapterComplete', { chapterId: id, next });
    this.save();
    return next;
  }

  // ---------------------------------------------------------------------------------------------- deck / rest points

  /** Distance to the nearest living enemy (Infinity when none). */
  nearestEnemyDist() {
    const g = this.game, pl = g.player, fs = g.combat && g.combat.fighters;
    if (!pl || !fs) return Infinity;
    let best = Infinity;
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (f === pl || f.team === 'player' || !f.alive || f.removed) continue;
      const dx = f.position.x - pl.position.x, dz = f.position.z - pl.position.z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /**
   * Deck editing is allowed at rest: after a room is cleared (or at chapter start) until the next room starts, with no
   * enemy nearby (the next room's enemies may already stand dormant at their posts further on).
   */
  canEditDeck() {
    const g = this.game, pl = g.player;
    if (g.state !== 'playing' || this.phase !== 'playing' || !this.restAvailable || !pl || !pl.alive) return false;
    return this.nearestEnemyDist() >= REST_CLEAR;
  }

  /** Replace the deck (validated against the library), apply it to the player, save. */
  setDeck(deck) {
    const p = this.progress;
    let d = deck;
    try { if (typeof MV.validateDeck === 'function') d = MV.validateDeck(deck, starterDeck() || undefined); } catch (e) { d = deck; }
    p.deck = P.cloneDeck(d);
    for (const id of P.deckMoveIds(p.deck)) P.addLearned(p, id);
    const pl = this.game.player;
    if (pl && typeof pl.setDeck === 'function') pl.setDeck(p.deck);
    else if (pl) pl.deck = p.deck;
    this.save();
  }

  /** Deck editor closed. */
  onDeckClosed(deck) { if (deck) this.setDeck(deck); }

  // ---------------------------------------------------------------------------------------------- loop

  fixedUpdate(dt) {
    this.progress.stats.playTime = (this.progress.stats.playTime || 0) + dt;
    if (this.phase === 'dying' && this._deathT >= 0) {
      this._deathT -= dt;
      if (this._deathT < 0) this._agePlayer().catch((e) => console.error('[flow] aging', e));
    } else if (this.phase === 'victory' && this._victoryT >= 0) {
      this._victoryT -= dt;
      if (this._victoryT < 0) this._showVictory().catch((e) => console.error('[flow] victory', e));
    }
  }

  update() {
    const g = this.game;
    if (g.state !== 'playing') return;
    const free = !g.paused && !g.uiOpen;
    const rest = this.canEditDeck();
    if (free && g.input && g.input.pressed('deck')) {
      const m = g.menus;
      if (rest && m && typeof m.openDeck === 'function') m.openDeck({ atRest: true });
      else if (g.hud && typeof g.hud.toast === 'function') {
        g.hud.toast('Not now', { kind: 'warn', label: 'Combat deck', sub: 'Only at a rest point, once the room is clear', ms: 2200, key: 'deck-denied' });
      }
    }
    this._prompts(true, rest);
  }

  _prompts(on, rest = false) {
    const hud = this.game.hud;
    if (!hud || typeof hud.setPrompt !== 'function') return;
    // first fights: a quiet lock-on hint until the player has used it once
    const pl = this.game.player;
    if (pl && pl.target) this._lockedOnce = true;
    const hintLock = !!(on && !this._lockedOnce && this.chapterId === ORDER[0] && pl && pl.alive && !rest && this.nearestEnemyDist() < 9);
    const showRest = !!(on && rest);
    // change-only: no prompt objects are built per frame
    if (showRest !== this._showRest) { this._showRest = showRest; hud.setPrompt('rest', showRest ? PROMPT_REST : null); }
    if (hintLock !== this._showLock) { this._showLock = hintLock; hud.setPrompt('lock', hintLock ? PROMPT_LOCK : null); }
  }

  // ---------------------------------------------------------------------------------------------- debug

  _installDebug() {
    const g = this.game;
    const d = g.debug || (g.debug = {});
    const self = this;
    /** Progress + flow state dump. */
    d.flow = () => ({
      phase: self.phase, chapterId: self.chapterId, state: g.state, busy: self.busy, restAvailable: self.restAvailable,
      canEditDeck: self.canEditDeck(), ephemeral: self.ephemeral, hasSave: self.hasSave(),
      ageDamageMult: +self.ageDamageMult().toFixed(3), ageHealthMult: +self.ageHealthMult().toFixed(3),
      progress: JSON.parse(P.serializeProgress(self.progress)),
    });
    /** Set the age (20..69); max health follows. */
    d.age = (n) => {
      const p = self.progress;
      p.age = Math.max(P.AGE_START, Math.min(P.AGE_MAX - 1, Math.round(+n || P.AGE_START)));
      g.events.emit('playerAged', { age: p.age, deaths: p.deaths, counter: p.deathCounter });
      return p.age;
    };
    /** Open the deck editor anywhere (tab: 'deck' | 'flow'). */
    d.openDeck = (tab) => (g.menus && typeof g.menus.openDeck === 'function' ? (g.menus.openDeck({ atRest: false, tab }), true) : false);
    /** Kill the player (runs the aging flow). */
    d.die = () => { const pl = g.player; if (pl && typeof pl.kill === 'function') pl.kill(null); else if (pl) self._onPlayerDown(); return true; };
    /** Pretend the chapter boss fell. */
    d.winChapter = () => { const ch = chapterById(self.chapterId); g.events.emit('bossDefeated', { bossId: ch && ch.boss ? ch.boss.id : null }); return true; };
    /** Learn every player move. */
    d.learnAll = () => { for (const id of Object.keys(MV.MOVES || {})) if (isPlayerMove(id)) P.addLearned(self.progress, id); return self.progress.learned.length; };
    /** Show any card: d.card('aging', {...}). */
    d.card = (kind, o = {}) => (g.menus && typeof g.menus.card === 'function' ? (g.menus.card({ kind, ...o }), true) : false);
    d.title = () => { self.showTitle(); return true; };
    d.clearSave = () => { P.clearSave(storage()); self._hasSave = false; return true; };
  }
}
