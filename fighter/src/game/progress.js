// Progress, save data and Sifu aging. Pure logic (no DOM, no three): unit-testable in node.
//   progress = { age, deaths, deathCounter, chapterId, chapterEntryAge, chapterEntryCounter, style, deck,
//                learned: [moveId], learn: {moveId: points}, completedChapters: [], bestAge: {}, entryAge: {}, stats }
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

/** A fresh run. `starterDeck` comes from the move library; its moves start learned. */
export function newProgress({ style = 'forsaken', starterDeck = null, chapterId = 'laundromat', age = AGE_START } = {}) {
  const deck = cloneDeck(starterDeck);
  return {
    version: 1,
    age, deaths: 0, deathCounter: 0,
    chapterId, chapterEntryAge: age, chapterEntryCounter: 0,
    style: STYLE_IDS.includes(style) ? style : 'forsaken',
    deck,
    learned: deckMoveIds(deck),
    learn: {},
    completedChapters: [],
    bestAge: {},     // chapterId -> lowest age at which the chapter was completed
    entryAge: {},    // chapterId -> lowest age at which the chapter was entered (chapter select replays)
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
export function sanitizeProgress(raw, { starterDeck = null, isMove = null, startOf = null, chapterIds = null } = {}) {
  const base = newProgress({ starterDeck });
  if (!raw || typeof raw !== 'object') return base;
  const p = base;
  p.age = clampN(Math.round(num(raw.age, AGE_START)), AGE_START, AGE_MAX - 1);
  p.deaths = Math.max(0, Math.round(num(raw.deaths, 0)));
  p.deathCounter = clampN(Math.round(num(raw.deathCounter, 0)), 0, 50);
  const chOk = (id) => typeof id === 'string' && (!chapterIds || chapterIds.includes(id));
  p.chapterId = chOk(raw.chapterId) ? raw.chapterId : base.chapterId;
  p.chapterEntryAge = clampN(Math.round(num(raw.chapterEntryAge, p.age)), AGE_START, p.age);
  p.chapterEntryCounter = clampN(Math.round(num(raw.chapterEntryCounter, 0)), 0, p.deathCounter);
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

/** Record entering a chapter (entry age / counter, lowest entry age per chapter). */
export function enterChapter(p, chapterId) {
  p.chapterId = chapterId;
  p.chapterEntryAge = p.age;
  p.chapterEntryCounter = p.deathCounter;
  if (!p.entryAge) p.entryAge = {};
  if (!(p.entryAge[chapterId] <= p.age)) p.entryAge[chapterId] = p.age;
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
