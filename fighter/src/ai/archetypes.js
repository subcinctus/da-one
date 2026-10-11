// Enemy personalities (FIGHTER.md §11). Every brain reads one scaled profile; bosses add two phases.
//
// Fields (probabilities are 0..1, durations seconds, distances metres):
//   style            defensive style id: forsaken (parry) / kahlt (absorb) / windfall (avoid)
//   health, damage   default max health and outgoing damage multiplier
//   speed            stick magnitude when closing in (1 = walk / run); circle = tangential stick while circling
//   ring             [min, max] circling radius around the player when not holding an attack token
//   aggression       how keen it is on the attack token (also shortens cooldowns)
//   cooldown         [min, max] pause between strings while holding the token
//   tokenStrings     [min, max] strings thrown before handing the token back
//   tokenRest        seconds before asking for a token again
//   strings          weights of string length [1, 2, 3]
//   telegraph        [min, max] the readable beat (stop, square up) before every attack
//   reaction         [min, max] delay before reacting to anything the player does (never frame-perfect)
//   block, ability, dodge   chance to block / use its style ability / dodge an incoming strike
//   readBlock        extra block chance against a read opener only (one the player keeps repeating; th.read)
//   timing           0..1 how well its parries / avoids are timed (1 = rarely early)
//   smart            0..1 reads attack properties (no blocking break moves, no absorbing them)
//   punish           chance to punish a whiffed player attack; counter = after its own successful defence
//   feint            chance to feint the opener of a string (then attack for real)
//   guardUp          chance to walk in with the guard up
//   heavyBias        taste for alternates (-1..1)
//   switch           chance per string to change stance to reach a better string (Absolver stance play)
//   staminaFloor     below this it stops attacking and backs off; staminaResume to start again
//   charge           [min, max] seconds it holds charge moves
//   taunt, bark      taunt clip / one-liner chance multipliers while circling
//   backoff          [min, max] step-out after a string
export const ARCHETYPES = {
  thug: {
    style: 'forsaken', health: 55, damage: 0.85,
    speed: 0.82, circle: 0.42, ring: [3.1, 4.4],
    aggression: 0.5, cooldown: [1.0, 1.9], tokenStrings: [1, 2], tokenRest: 1.6,
    strings: [0.55, 0.4, 0.05], telegraph: [0.24, 0.34], reaction: [0.27, 0.35],
    block: 0.24, ability: 0.03, dodge: 0.04, timing: 0.35, smart: 0.1, readBlock: 0.05,
    punish: 0.3, counter: 0.35, feint: 0, guardUp: 0.1, heavyBias: -0.1, switch: 0,
    staminaFloor: 24, staminaResume: 55, charge: [0, 0.2], taunt: 1, bark: 1, backoff: [0.5, 1.0],
  },
  brawler: {
    style: 'forsaken', health: 80, damage: 1.0,
    speed: 0.86, circle: 0.36, ring: [3.0, 4.2],
    aggression: 0.62, cooldown: [0.8, 1.5], tokenStrings: [1, 2], tokenRest: 1.4,
    strings: [0.3, 0.5, 0.2], telegraph: [0.22, 0.32], reaction: [0.22, 0.32],
    block: 0.46, ability: 0.08, dodge: 0.03, timing: 0.5, smart: 0.35,
    punish: 0.45, counter: 0.5, feint: 0.05, guardUp: 0.55, heavyBias: 0.45, switch: 0.05,
    staminaFloor: 20, staminaResume: 50, charge: [0.15, 0.5], taunt: 0.8, bark: 0.8, backoff: [0.35, 0.8],
  },
  swift: {
    style: 'windfall', health: 60, damage: 0.9,
    speed: 1, circle: 0.55, ring: [3.0, 4.0],
    aggression: 0.7, cooldown: [0.6, 1.2], tokenStrings: [1, 2], tokenRest: 1.1,
    strings: [0.15, 0.45, 0.4], telegraph: [0.16, 0.24], reaction: [0.18, 0.28],
    block: 0.08, ability: 0.3, dodge: 0.24, timing: 0.6, smart: 0.5,
    punish: 0.55, counter: 0.7, feint: 0.15, guardUp: 0.05, heavyBias: -0.25, switch: 0.15,
    staminaFloor: 26, staminaResume: 60, charge: [0, 0.2], taunt: 1.2, bark: 0.7, backoff: [0.4, 0.8],
  },
  heavy: {
    style: 'kahlt', health: 100, damage: 1.12,
    speed: 0.72, circle: 0.3, ring: [3.2, 4.6],
    aggression: 0.55, cooldown: [1.1, 1.9], tokenStrings: [1, 2], tokenRest: 1.8,
    strings: [0.5, 0.45, 0.05], telegraph: [0.26, 0.35], reaction: [0.24, 0.34],
    block: 0.2, ability: 0.34, dodge: 0, timing: 0.45, smart: 0.4,
    punish: 0.5, counter: 0.6, feint: 0, guardUp: 0.3, heavyBias: 0.7, switch: 0,
    staminaFloor: 16, staminaResume: 45, charge: [0.3, 0.6], taunt: 0.7, bark: 0.6, backoff: [0.5, 1.0],
  },
};

/**
 * Bosses: a base archetype plus per-phase overrides. Phase 2 starts at 50% health (line in levels/dialogue.js).
 * sigBias nudges signature moves (small: the planner's variety terms and the every-3rd-string signature cadence
 * bring them in, so a fight is a mix rather than one repeated signature string); allStances lets it switch to any
 * stance for the string it wants.
 */
export const BOSSES = {
  tadao: {
    base: 'brawler', style: 'forsaken', health: 230, damage: 1.0, name: 'Tadao', look: 'tadao',
    // The Accountant: tidy, patient, parries, punishes every rounding error.
    phases: [
      { speed: 0.8, ring: [2.6, 3.4], aggression: 0.8, cooldown: [0.7, 1.3], strings: [0.4, 0.5, 0.1],
        telegraph: [0.2, 0.3], reaction: [0.2, 0.3], block: 0.26, ability: 0.38, dodge: 0.04, timing: 0.65, smart: 0.7,
        punish: 0.8, counter: 0.8, feint: 0.08, guardUp: 0.4, heavyBias: 0.1, switch: 0.1, sigBias: 2,
        staminaFloor: 18, staminaResume: 45, charge: [0.2, 0.45], backoff: [0.3, 0.6] },
      { speed: 0.9, aggression: 0.95, cooldown: [0.45, 0.9], strings: [0.15, 0.45, 0.4], telegraph: [0.17, 0.26],
        reaction: [0.17, 0.26], ability: 0.4, block: 0.3, feint: 0.3, sigBias: 4, charge: [0.4, 0.6], switch: 0.2 },
    ],
  },
  madame_shu: {
    base: 'swift', style: 'windfall', health: 260, damage: 1.0, name: 'Madame Shu', look: 'madame_shu',
    // Long legs, longer memory: keeps you at kicking distance and slips everything.
    phases: [
      { speed: 0.95, ring: [3.0, 3.8], aggression: 0.7, cooldown: [0.75, 1.35], strings: [0.3, 0.5, 0.2],
        telegraph: [0.18, 0.28], reaction: [0.19, 0.28], block: 0.1, ability: 0.42, dodge: 0.2, timing: 0.7, smart: 0.7,
        punish: 0.7, counter: 0.85, feint: 0.12, guardUp: 0.05, heavyBias: 0.15, switch: 0.25, sigBias: 2,
        staminaFloor: 22, staminaResume: 50, backoff: [0.35, 0.7] },
      { aggression: 1, cooldown: [0.35, 0.8], strings: [0.1, 0.4, 0.5], telegraph: [0.16, 0.24], reaction: [0.16, 0.25],
        ability: 0.48, dodge: 0.22, counter: 0.95, feint: 0.2, sigBias: 4, switch: 0.35 },
    ],
  },
  brick: {
    base: 'heavy', style: 'kahlt', health: 320, damage: 1.05, name: 'Brick', look: 'brick',
    // Absorbs your best shot, then answers with furniture-grade force.
    phases: [
      { speed: 0.74, ring: [2.6, 3.4], aggression: 0.8, cooldown: [0.9, 1.5], strings: [0.5, 0.45, 0.05],
        telegraph: [0.26, 0.35], reaction: [0.24, 0.32], block: 0.16, ability: 0.36, dodge: 0, timing: 0.55, smart: 0.6,
        punish: 0.7, counter: 0.75, feint: 0, guardUp: 0.35, heavyBias: 0.6, switch: 0.1, sigBias: 2,
        staminaFloor: 14, staminaResume: 40, charge: [0.3, 0.6], backoff: [0.4, 0.8] },
      { speed: 0.84, aggression: 0.95, cooldown: [0.55, 1.0], strings: [0.3, 0.5, 0.2], telegraph: [0.22, 0.32],
        ability: 0.5, sigBias: 4, charge: [0.5, 0.6], feint: 0.08 },
    ],
  },
  mr_golden: {
    base: 'swift', style: 'forsaken', health: 340, damage: 1.05, name: 'Mr. Golden', look: 'mr_golden',
    // Fights in every stance, reads everything, feints like a contract clause. Parries rather than blocks: his style
    // (forsaken) should show a couple of times a fight even against varied play, so ability takes part of the block share.
    allStances: true,
    phases: [
      { speed: 0.92, ring: [2.8, 3.6], aggression: 0.85, cooldown: [0.55, 1.0], strings: [0.2, 0.5, 0.3],
        telegraph: [0.18, 0.27], reaction: [0.18, 0.27], block: 0.2, ability: 0.34, dodge: 0.12, timing: 0.7, smart: 0.85,
        punish: 0.8, counter: 0.85, feint: 0.18, guardUp: 0.25, heavyBias: 0.1, switch: 0.55, sigBias: 2,
        staminaFloor: 20, staminaResume: 48, charge: [0.2, 0.5], backoff: [0.3, 0.6] },
      { aggression: 1, cooldown: [0.35, 0.75], strings: [0.05, 0.4, 0.55], telegraph: [0.15, 0.23], reaction: [0.15, 0.24],
        ability: 0.46, block: 0.16, dodge: 0.14, feint: 0.32, switch: 0.7, sigBias: 4 },
    ],
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);
export const BOSS_IDS = Object.keys(BOSSES);

/** Mild chapter scaling (1..4): health, damage, reactions, defence, aggression. */
export function chapterScale(index = 1) {
  const k = Math.max(0, Math.min(3, (index | 0) - 1));
  return {
    health: 1 + 0.1 * k, damage: 1 + 0.07 * k, reaction: -0.025 * k, defense: 1 + 0.14 * k,
    aggression: 1 + 0.07 * k, telegraph: 1 - 0.04 * k,
  };
}

const lerpPair = (p, d) => [Math.max(0.15, p[0] + d), Math.max(0.18, p[1] + d)];

/**
 * Resolve a profile: archetype id or boss id, phase (0 / 1) and chapter index. Returns a NEW plain object
 * (only at attach / phase change, never per frame).
 */
export function resolveProfile(id, phase = 0, chapter = 1) {
  const boss = BOSSES[id] || null;
  const baseId = boss ? boss.base : (ARCHETYPES[id] ? id : 'thug');
  const p = { readBlock: 0, ...ARCHETYPES[baseId], id: boss ? id : baseId, base: baseId, boss: !!boss, sigBias: 0, allStances: false };
  if (boss) {
    p.style = boss.style; p.health = boss.health; p.damage = boss.damage; p.allStances = !!boss.allStances;
    p.taunt = 0; p.bark = 0;
    Object.assign(p, boss.phases[0]);
    if (phase >= 1 && boss.phases[1]) Object.assign(p, boss.phases[1]);
  }
  const s = chapterScale(chapter);
  p.reaction = lerpPair(p.reaction, s.reaction);
  p.telegraph = [p.telegraph[0] * s.telegraph, p.telegraph[1] * s.telegraph];
  // bosses are tuned per fight; regular enemies get the chapter's defence / aggression bump
  if (!boss) {
    p.block = Math.min(0.7, p.block * s.defense);
    p.readBlock = Math.min(0.15, p.readBlock * s.defense);
    p.ability = Math.min(0.6, p.ability * s.defense);
    p.dodge = Math.min(0.5, p.dodge * s.defense);
    p.aggression = Math.min(1, p.aggression * s.aggression);
    p.timing = Math.min(0.9, p.timing + 0.06 * (chapter - 1));
  }
  p.healthScale = s.health;
  p.damageScale = s.damage;
  return p;
}
