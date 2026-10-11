// Progress, save data and Sifu aging. Pure logic (no DOM, no three): unit-testable in node.
//   progress = { age, deaths, deathCounter, chapterId, chapterEntryAge, chapterEntryCounter, style, deck,
//                learned: [moveId], learn: {moveId: points}, completedChapters: [], bestAge: {}, entryAge: {},
//                entryCounter: {}, stats }
// Death counter policy (one rule for every way back into a chapter):
//   - entryAge[ch] / entryCounter[ch]: the best (lowest age, then lowest counter) state the chapter was entered with.
//     Chapter select replays from it, so a replay equals a game over and is never better than one.
//   - Game over: back to the chapter's entry state, then slack (gameOverRestart): the counter drops (and, past that,
//     the age) until three more deaths fit under AGE_MAX, so a chapter can never lock into one-death game overs.
//   - Relief: a boss -1 (flow.completeChapter), a fight room cleared without dying in it -1 (flow, roomCleared).
// Saved to localStorage under SAVE_KEY; every storage access is wrapped in try/catch (private mode, quota, blocked).

export const SAVE_KEY = 'laststance.save.v1';
export const AGE_START = 20;
export const AGE_MAX = 70;
const STANCE_IDS = ['FR', 'FL', 'BR', 'BL'];
const STYLE_IDS = ['forsaken', 'kahlt', 'windfall'];

/** Deep copy of a deck ({FR: {main, alt}, ...}); missing slots become null. */
export function cloneDeck(deck) {
  const out = {};
  for (const st of STANCE_IDS) out[st] = { main: deck?.[st]?.main ?? null, alt: deck?.[st]?.alt ?? null };
  return out;
}

/** Move ids slotted in a deck (unique). */
export function deckMoveIds(deck) {
  const ids = [];
  for (const st of STANCE_IDS) for (const k of ['main', 'alt']) { const id = deck?.[st]?.[k]; if (id && !ids.includes(id)) ids.push(id); }
  return ids;
}

/**
 * A fresh run. `starterDeck` comes from the move library; its moves start learned. `starterExtra` (move ids) are
 * learned too but not equipped, so the first rest point already offers a real deck choice.
 */
export function newProgress({ style = 'forsaken', starterDeck = null, starterExtra = [], chapterId = 'laundromat', age = AGE_START } = {}) {
  const deck = cloneDeck(starterDeck);
  const learned = deckMoveIds(deck);
  if (Array.isArray(starterExtra)) for (const id of starterExtra) if (typeof id === 'string' && id && !learned.includes(id)) learned.push(id);
  return {
    version: 1,
    age, deaths: 0, deathCounter: 0,
    chapterId, chapterEntryAge: age, chapterEntryCounter: 0,
    style: STYLE_IDS.includes(style) ? style : 'forsaken',
    deck,
    learned,
    learn: {},
    completedChapters: [],
    bestAge: {},     // chapterId -> lowest age at which the chapter was completed
    entryAge: {},    // chapterId -> lowest age at which the chapter was entered (chapter select replays)
    entryCounter: {},// chapterId -> the death counter that came with entryAge
    stats: { kills: 0, playTime: 0, learnedCount: 0 },
    started: false,
  };
}

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Validate a loaded save against defaults. `isMove(id)` (optional) filters unknown move ids; `startOf(id)` (optional)
 * returns a move's start stance so slots only hold moves of their own stance.
 */
export function sanitizeProgress(raw, { starterDeck = null, starterExtra = [], isMove = null, startOf = null, chapterIds = null } = {}) {
  const base = newProgress({ starterDeck, starterExtra });
  if (!raw || typeof raw !== 'object') return base;
  const p = base;
  p.age = clampN(Math.round(num(raw.age, AGE_START)), AGE_START, AGE_MAX - 1);
  p.deaths = Math.max(0, Math.round(num(raw.deaths, 0)));
  p.deathCounter = clampN(Math.round(num(raw.deathCounter, 0)), 0, 50);
  const chOk = (id) => typeof id === 'string' && (!chapterIds || chapterIds.includes(id));
  p.chapterId = chOk(raw.chapterId) ? raw.chapterId : base.chapterId;
  p.chapterEntryAge = clampN(Math.round(num(raw.chapterEntryAge, p.age)), AGE_START, p.age);
  p.chapterEntryCounter = clampN(Math.round(num(raw.chapterEntryCounter, 0)), 0, 50);   // room-clear relief can take the counter below it
  p.style = STYLE_IDS.includes(raw.style) ? raw.style : 'forsaken';
  const okMove = (id) => typeof id === 'string' && (!isMove || isMove(id));
  const learned = Array.isArray(raw.learned) ? raw.learned : (raw.learned && typeof raw.learned === 'object' ? Object.keys(raw.learned) : []);
  for (const id of learned) if (okMove(id) && !p.learned.includes(id)) p.learned.push(id);
  if (raw.learn && typeof raw.learn === 'object') {
    for (const [id, v] of Object.entries(raw.learn)) if (okMove(id) && num(v, 0) > 0) p.learn[id] = num(v, 0);
  }
  if (raw.deck && typeof raw.deck === 'object') {
    for (const st of STANCE_IDS) for (const k of ['main', 'alt']) {
      const id = raw.deck?.[st]?.[k];
      if (okMove(id) && (!startOf || startOf(id) === st)) p.deck[st][k] = id;
    }
  }
  for (const id of deckMoveIds(p.deck)) if (!p.learned.includes(id)) p.learned.push(id);
  if (Array.isArray(raw.completedChapters)) p.completedChapters = raw.completedChapters.filter(chOk);
  for (const key of ['bestAge', 'entryAge']) {
    if (raw[key] && typeof raw[key] === 'object') {
      for (const [id, v] of Object.entries(raw[key])) if (chOk(id)) p[key][id] = clampN(Math.round(num(v, AGE_START)), AGE_START, AGE_MAX);
    }
  }
  if (raw.entryCounter && typeof raw.entryCounter === 'object') {
    for (const [id, v] of Object.entries(raw.entryCounter)) if (chOk(id)) p.entryCounter[id] = clampN(Math.round(num(v, 0)), 0, 50);
  }
  // older saves: the current chapter's entry counter is known when its entry age is the recorded one
  if (p.entryCounter[p.chapterId] === undefined && p.entryAge[p.chapterId] === p.chapterEntryAge) p.entryCounter[p.chapterId] = p.chapterEntryCounter;
  if (raw.stats && typeof raw.stats === 'object') {
    p.stats.kills = Math.max(0, Math.round(num(raw.stats.kills, 0)));
    p.stats.playTime = Math.max(0, num(raw.stats.playTime, 0));
    p.stats.learnedCount = Math.max(0, Math.round(num(raw.stats.learnedCount, 0)));
  }
  p.started = !!raw.started;
  return p;
}

/** Plain JSON-able copy (learned as array). */
export function serializeProgress(p) {
  const learned = p.learned && typeof p.learned.forEach === 'function' && !Array.isArray(p.learned) ? [...p.learned] : (p.learned || []);
  return JSON.stringify({ ...p, learned });
}

/** Read the save (null when missing / unreadable). */
export function readSave(storage, key = SAVE_KEY) {
  try {
    const s = storage && storage.getItem(key);
    if (!s) return null;
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

/** Write the save; returns true on success. */
export function writeSave(storage, p, key = SAVE_KEY) {
  try { if (!storage) return false; storage.setItem(key, serializeProgress(p)); return true; } catch (e) { return false; }
}

/** Delete the save. */
export function clearSave(storage, key = SAVE_KEY) {
  try { if (storage) storage.removeItem(key); return true; } catch (e) { return false; }
}

// ------------------------------------------------------------------------------------------------ aging (Sifu)

/** Damage multiplier for an age: x(1 + (age - 20) * 0.012). */
export const ageDamageMult = (age) => 1 + (Math.max(AGE_START, age) - AGE_START) * 0.012;
/** Max-health multiplier for an age: x(1 - (age - 20) * 0.008). */
export const ageHealthMult = (age) => Math.max(0.2, 1 - (Math.max(AGE_START, age) - AGE_START) * 0.008);

/**
 * Apply one player death: deathCounter += 1, age += deathCounter. Returns { from, to, counter, gameOver }.
 * `to` is the uncapped new age; gameOver when it reaches AGE_MAX.
 */
export function applyDeath(p) {
  const from = p.age;
  p.deaths = (p.deaths || 0) + 1;
  p.deathCounter = (p.deathCounter || 0) + 1;
  p.age = from + p.deathCounter;
  const gameOver = p.age >= AGE_MAX;
  return { from, to: p.age, counter: p.deathCounter, gameOver };
}

/** Restart the current chapter after a game over: back to the age and counter the chapter was entered with. */
export function resetToChapterEntry(p) {
  p.age = Math.min(AGE_MAX - 1, p.chapterEntryAge || AGE_START);
  p.deathCounter = Math.max(0, p.chapterEntryCounter || 0);
}

/** Deaths that must fit after a game over restart before the next game over. */
export const GAME_OVER_SLACK = 3;

/**
 * The state a game over restarts the chapter with (pure; see applyGameOverRestart): the chapter entry age and
 * counter, then slack. The counter drops until GAME_OVER_SLACK more deaths fit under AGE_MAX
 * (age + 3 * counter + 6 < AGE_MAX for three); when even counter 0 cannot fit them (entry age 64+), the age drops
 * too (to AGE_MAX - 7 = 63 for three). Returns { age, counter }.
 */
export function gameOverRestart(p, slack = GAME_OVER_SLACK) {
  let age = Math.min(AGE_MAX - 1, p.chapterEntryAge || AGE_START);
  let counter = Math.max(0, p.chapterEntryCounter || 0);
  const need = (c) => slack * c + (slack * (slack + 1)) / 2;   // age gained over `slack` deaths from counter c
  while (counter > 0 && age + need(counter) >= AGE_MAX) counter--;
  if (age + need(counter) >= AGE_MAX) age = Math.max(AGE_START, AGE_MAX - 1 - need(counter));
  return { age, counter };
}

/** Apply a game over restart: age + counter, and they become the chapter's entry state (repeat game overs are stable). */
export function applyGameOverRestart(p, r = gameOverRestart(p)) {
  p.age = r.age;
  p.deathCounter = r.counter;
  p.chapterEntryAge = r.age;
  p.chapterEntryCounter = r.counter;
  recordEntry(p, p.chapterId);
  return r;
}

/**
 * Remember the best state a chapter was entered with (lowest age, then lowest counter at that age): chapter select
 * replays from it.
 */
export function recordEntry(p, chapterId) {
  if (!chapterId) return;
  if (!p.entryAge) p.entryAge = {};
  if (!p.entryCounter) p.entryCounter = {};
  const a = p.entryAge[chapterId], c = p.entryCounter[chapterId];
  const better = !(typeof a === 'number') || p.age < a || (p.age === a && !(c <= p.deathCounter));
  if (better) { p.entryAge[chapterId] = p.age; p.entryCounter[chapterId] = p.deathCounter; }
}

/**
 * Chapter select: the state a replay of `chapterId` starts with. The recorded entry state when it is better than the
 * current one (younger, or the same age with a lower counter), else the current state (a player who arrives younger
 * by replaying earlier chapters keeps it). Returns { age, counter }.
 */
export function chapterReplayState(p, chapterId) {
  const a = p.entryAge && p.entryAge[chapterId];
  if (typeof a !== 'number') return { age: p.age, counter: p.deathCounter };
  const recorded = p.entryCounter && typeof p.entryCounter[chapterId] === 'number' ? p.entryCounter[chapterId] : 0;
  if (a < p.age || (a === p.age && recorded < p.deathCounter)) return { age: a, counter: recorded };
  return { age: p.age, counter: p.deathCounter };
}

/** Record entering a chapter (entry age / counter, best entry state per chapter). */
export function enterChapter(p, chapterId) {
  p.chapterId = chapterId;
  p.chapterEntryAge = p.age;
  p.chapterEntryCounter = p.deathCounter;
  recordEntry(p, chapterId);
  p.started = true;
}

/**
 * Mark the chapter complete. Defeating a boss calms the talisman: the death counter drops by one.
 * Returns the next chapter id (or null after the last). `order` = chapter ids in play order.
 */
export function completeChapterProgress(p, chapterId, order) {
  if (!p.completedChapters.includes(chapterId)) p.completedChapters.push(chapterId);
  if (!p.bestAge) p.bestAge = {};
  if (!(p.bestAge[chapterId] <= p.age)) p.bestAge[chapterId] = p.age;
  const i = order.indexOf(chapterId);
  const next = i >= 0 && i + 1 < order.length ? order[i + 1] : null;
  if (next) p.chapterId = next;
  return next;
}

/** Chapters the player may pick in chapter select: completed ones, the current one and the one after the last cleared. */
export function unlockedChapters(p, order) {
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const prevDone = i === 0 || p.completedChapters.includes(order[i - 1]);
    if (prevDone || p.completedChapters.includes(id) || p.chapterId === id) out.push(id);
  }
  return out;
}

/** Add a learned move id (array or Set). Returns true when it was new. */
export function addLearned(p, id) {
  const l = p.learned;
  if (l && typeof l.add === 'function') { if (l.has(id)) return false; l.add(id); return true; }
  if (!Array.isArray(p.learned)) p.learned = [];
  if (p.learned.includes(id)) return false;
  p.learned.push(id);
  return true;
}

/** True when the move id is learned. */
export function isLearnedId(p, id) {
  const l = p && p.learned;
  if (!l) return false;
  return typeof l.has === 'function' ? l.has(id) : Array.isArray(l) && l.includes(id);
}
