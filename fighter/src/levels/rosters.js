// Chapter rosters (FIGHTER.md §11 Encounters): 3 fight rooms of 2-3 waves each with escalating archetypes, then the
// boss. Waves are lists of archetypes; `nextAt` = the next wave walks in once this many (or fewer) enemies are left.
// Health and damage come from the archetype profile scaled by chapter (ai/archetypes.js).
import { resolveProfile, BOSSES } from '../ai/archetypes.js';
import { CHAPTERS, chapterById } from '../data/chapters.js';

/** Enemy names per chapter (the HUD shows them over health bars). */
export const NAMES = {
  laundromat: { thug: 'Laundry Thug', brawler: 'Presser', swift: 'Courier', heavy: 'Boilerman' },
  market: { thug: 'Stall Hand', brawler: 'Butcher', swift: 'Runner', heavy: 'Wok Man' },
  gym: { thug: 'Gym Rat', brawler: 'Bruiser', swift: 'Kickboxer', heavy: 'Powerlifter' },
  tower: { thug: 'Security', brawler: 'Enforcer', swift: 'Associate', heavy: 'Bodyguard' },
};

const ROOMS = {
  laundromat: [
    { waves: [['thug', 'thug'], ['thug']], nextAt: 1 },
    { waves: [['thug', 'thug'], ['swift', 'thug']], nextAt: 1 },
    { waves: [['thug', 'brawler'], ['thug', 'thug'], ['brawler']], nextAt: 1 },
  ],
  market: [
    { waves: [['thug', 'thug', 'swift'], ['thug', 'swift']], nextAt: 1 },
    { waves: [['swift', 'thug'], ['brawler', 'thug'], ['swift', 'swift']], nextAt: 1 },
    { waves: [['brawler', 'swift'], ['thug', 'thug', 'swift'], ['heavy']], nextAt: 1 },
  ],
  gym: [
    { waves: [['brawler', 'thug'], ['thug', 'brawler', 'thug']], nextAt: 1 },
    { waves: [['heavy', 'thug'], ['swift', 'swift'], ['brawler', 'thug']], nextAt: 1 },
    { waves: [['heavy', 'brawler'], ['swift', 'thug', 'thug'], ['heavy', 'brawler']], nextAt: 1 },
  ],
  tower: [
    { waves: [['swift', 'brawler', 'thug'], ['heavy', 'thug']], nextAt: 1 },
    { waves: [['heavy', 'swift'], ['brawler', 'swift', 'thug'], ['heavy', 'swift']], nextAt: 1 },
    { waves: [['brawler', 'heavy', 'swift'], ['swift', 'swift', 'thug'], ['heavy', 'brawler']], nextAt: 2 },
  ],
};

/** Most enemies on the floor at once (waves wait for room). */
export const MAX_ALIVE = 4;

/**
 * Full roster for a chapter (fresh objects every call):
 * { chapterId, index, rooms: [{ kind: 'fight', waves: [[{ archetype, name, health, damageMult, style, seed }]], nextAt },
 *   ..., { kind: 'boss', bossId, name, health, damageMult, style }] }
 */
export function buildRoster(chapterId) {
  const ch = chapterById(chapterId) || CHAPTERS[0];
  const id = ch.id;
  const index = ch.index || 1;
  const names = NAMES[id] || NAMES.laundromat;
  let seed = 101 * index;
  const rooms = (ROOMS[id] || ROOMS.laundromat).map((r, ri) => ({
    kind: 'fight', index: ri, nextAt: r.nextAt ?? 1,
    waves: r.waves.map((w) => w.map((a) => {
      const p = resolveProfile(a, 0, index);
      seed += 17;
      return { archetype: a, name: names[a] || a, health: Math.round(p.health * p.healthScale),
        damageMult: +(p.damage * p.damageScale).toFixed(3), style: p.style, seed };
    })),
  }));
  const bossId = ch.boss?.id && BOSSES[ch.boss.id] ? ch.boss.id : 'tadao';
  const bp = resolveProfile(bossId, 0, index);
  rooms.push({ kind: 'boss', index: rooms.length, bossId, name: BOSSES[bossId].name, fullName: ch.boss?.name || BOSSES[bossId].name,
    health: bp.health, damageMult: bp.damage, style: bp.style, stance: ch.boss?.stance || null });
  return { chapterId: id, index, title: ch.title, rooms };
}

/** Enemy count per fight room (dialogue / UI flavour). */
export function rosterCount(chapterId) {
  return buildRoster(chapterId).rooms.reduce((n, r) => n + (r.waves ? r.waves.reduce((m, w) => m + w.length, 0) : 0), 0);
}
