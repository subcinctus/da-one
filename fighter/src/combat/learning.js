// Learning moves by defending against them (Absolver). Progress lives in game.flow.progress (learn / learned), with a
// local fallback object while Flow is a stub. Emits learnProgress / learned (FIGHTER.md §8).
import { isLibraryMove } from './movedata.js';

const LOCAL = { learn: {}, learned: [] };

/** The progress object holding learn points + learned move ids. */
export function progressOf(game) {
  const p = game.flow && game.flow.progress;
  return p && typeof p === 'object' ? p : LOCAL;
}

/** True when the player already knows `moveId` (learned list, or currently in the player's deck). */
export function isLearned(game, moveId) {
  const p = progressOf(game);
  const l = p.learned;
  if (l) {
    if (typeof l.has === 'function' && l.has(moveId)) return true;
    if (Array.isArray(l) && l.includes(moveId)) return true;
  }
  const deck = game.player && game.player.deck;
  if (deck) for (const st in deck) { const s = deck[st]; if (s && (s.main === moveId || s.alt === moveId)) return true; }
  return false;
}

function markLearned(p, moveId) {
  if (!p.learned) p.learned = [];
  const l = p.learned;
  if (typeof l.add === 'function') l.add(moveId);
  else if (Array.isArray(l) && !l.includes(moveId)) l.push(moveId);
}

/**
 * Add learning points for the player defending against `move`. Boss moves, fallbacks and known moves are skipped.
 * @returns {boolean} true when the move got unlocked by this call
 */
export function addLearn(game, defender, move, points) {
  if (!defender || defender !== game.player || !move || move.boss || move.focus || !(move.learn > 0)) return false;
  const id = move.id;
  if (!isLibraryMove(id) || isLearned(game, id)) return false;
  const p = progressOf(game);
  if (!p.learn || typeof p.learn !== 'object') p.learn = {};
  const max = move.learn;
  const value = Math.min(max, (p.learn[id] || 0) + points);
  p.learn[id] = value;
  game.events.emit('learnProgress', { moveId: id, value, max, move });
  if (value >= max) {
    markLearned(p, id);
    game.events.emit('learned', { moveId: id, move });
    const f = game.flow;
    try {
      if (f && typeof f.save === 'function') f.save();
      else if (f && typeof f.saveProgress === 'function') f.saveProgress();
    } catch (e) { /* persistence is optional */ }
    return true;
  }
  return false;
}
