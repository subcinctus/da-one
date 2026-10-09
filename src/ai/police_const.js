// Police tuning tables (POLICE agent). Pure data: importable from Node for unit tests.
//
// Everything that decides how hard a chase feels lives here so it can be tuned in one place:
// response size per wanted level, how accurate / fast / aggressive the units are, evasion timings, arrest rules.

/** Global tuning. Distances in metres, times in seconds, speeds in m/s. */
export const TUNE = {
  // ---- spawning / streaming
  SPAWN_MIN: 70,            // police cars appear on roads this far from the player...
  SPAWN_MAX: 130,           // ...and no farther (widened automatically when no road qualifies)
  RESPAWN_DELAY: 8,         // a lost unit (wrecked, stolen, crew killed) is replaced after this delay
  RELOCATE_DIST: 230,       // units left this far behind are recycled closer to the action
  MAX_FOOT_OFFICERS: 12,    // cap on officers walking around (perf + fairness)
  HELI_RESPAWN: 22,
  ROADBLOCK_COOLDOWN: 18,
  ROADBLOCK_LIFE: 45,

  // ---- perception
  LOS_INTERVAL: 0.25,       // each unit re-checks line of sight ~4 times a second (staggered)
  LOS_RANGE: 70,            // cars and officers see this far
  HELI_LOS_RANGE: 120,      // the helicopter sees this far
  SENSE_RANGE: 5,           // a cop this close always notices the player (hearing / peripheral vision)
  SEEN_GRACE: 0.75,         // "searching" starts this long after the last sighting (no flicker)
  DISPATCH_TRACK: 3,        // a fresh wanted level: dispatch tracks the suspect this long before sight is needed
  REPORT_TRACK: 1.5,        // a reported crime / shots near cops: tracked this long
  WITNESS_RANGE: 40,        // a cop within this range with line of sight witnesses a crime
  GUNFIRE_RANGE: 50,        // shooting within this range of a cop is a crime
  CIVIL_REPORT_RANGE: 35,   // civilians this close to unwitnessed gunfire may call it in

  // ---- evasion (GTA V style)
  EVADE_BASE: 8,            // hidden for EVADE_BASE + EVADE_PER_STAR * stars seconds -> wanted clears
  EVADE_PER_STAR: 4,
  SEARCH_BASE: 40,          // search-area radius = SEARCH_BASE + SEARCH_PER_STAR * stars
  SEARCH_PER_STAR: 15,

  // ---- busted
  BUST_RANGE: 2.0,
  BUST_TIME: 1.5,
  BUST_FREEZE: 3.0,
  BUST_SPEED: 2.2,          // the player counts as "giving up" below this horizontal speed
  BUST_FINE: 0.1,           // fraction of the player's money lost

  // ---- cars
  STOP_DIST: 11,            // cars stop this far from a player on foot
  EXIT_RANGE: 18,           // ...and the crew bails out when within this range and slow
  RETURN_DIST: 25,          // officers run back to their car when the player drives this far away
  DIRECT_RANGE: 40,         // closer than this (or with a clear view) cars chase directly instead of following roads
  TURN_SPEED: 11,           // corner speed at 90-degree intersections
  PATROL_SPEED_K: 0.85,     // ambient patrols drive at this fraction of the speed limit

  // ---- heat
  INCIDENT_WINDOW: 1.5,     // all stars gained within this window count as one incident...
  INCIDENT_CAP: 2,          // ...which can add at most this many stars (one TNT blast is not an instant 5 stars)
  OFFENCE_MEMORY: 90,       // unwitnessed minor offences are forgotten after this long
};

/**
 * Response per wanted level (index = stars).
 *   cars         police cruisers chasing     carsLater  cruisers after LATER_T seconds at that level
 *   swat         SWAT vans                    heli       police helicopters      roadblocks  5-star roadblocks
 *   lethal       'never' (arrest only) | 'armed' (shoot when the player has a gun out or drives) | 'always'
 *   shooters     officers allowed to fire at the same time (attack tokens)
 *   hit          base chance a single shot hits (scaled by distance, target speed, aim time; capped)
 *   react        seconds of continuous sight before an officer fires his first shot
 *   burst        [min, max] shots per burst         pause [min, max] seconds between bursts
 *   speed        top pursuit speed (m/s)            ram   cars try to ram the player's vehicle
 *   driveBy      passengers shoot from pursuing cars
 */
export const LEVELS = [
  { cars: 0, carsLater: 0, swat: 0, heli: 0, roadblocks: false, lethal: 'never', shooters: 0, hit: 0, react: 1.2,
    burst: [0, 0], pause: [3, 3], speed: 0, ram: false, driveBy: false },
  { cars: 1, carsLater: 1, swat: 0, heli: 0, roadblocks: false, lethal: 'never', shooters: 1, hit: 0.12, react: 1.0,
    burst: [1, 2], pause: [2.2, 3.2], speed: 25, ram: false, driveBy: false },
  { cars: 2, carsLater: 3, swat: 0, heli: 0, roadblocks: false, lethal: 'armed', shooters: 2, hit: 0.145, react: 0.85,
    burst: [2, 3], pause: [1.9, 2.9], speed: 28, ram: false, driveBy: false },
  { cars: 4, carsLater: 4, swat: 0, heli: 0, roadblocks: false, lethal: 'always', shooters: 2, hit: 0.175, react: 0.7,
    burst: [2, 3], pause: [1.7, 2.6], speed: 31, ram: true, driveBy: true },
  { cars: 5, carsLater: 5, swat: 1, heli: 1, roadblocks: false, lethal: 'always', shooters: 3, hit: 0.21, react: 0.6,
    burst: [2, 4], pause: [1.5, 2.4], speed: 33, ram: true, driveBy: true },
  { cars: 6, carsLater: 6, swat: 1, heli: 1, roadblocks: true, lethal: 'always', shooters: 3, hit: 0.245, react: 0.5,
    burst: [3, 4], pause: [1.4, 2.2], speed: 35, ram: true, driveBy: true },
];

/** Seconds at 2 stars before the third cruiser joins. */
export const LATER_T = 20;

/** Officer kinds. */
export const OFFICER_TYPES = {
  cop: { look: 'cop', health: 100, weapon: 'pistol', mag: 12, reload: 1.5, shotGap: 0.24, range: 48, keep: [6, 15],
    run: 6.1, walk: 1.7, strafe: 2.3, armor: 0, hitBonus: 0, drop: 'ammo:pistol', dropAmount: [12, 24] },
  swat: { look: 'swat', health: 160, weapon: 'rifle', mag: 30, reload: 2.0, shotGap: 0.12, range: 65, keep: [8, 19],
    run: 5.7, walk: 1.6, strafe: 2.1, armor: 0.2, hitBonus: 0.05, drop: 'ammo:pistol', dropAmount: [24, 36] },
};

/** Base chance per wanted level that a heli door-gunner shot hits. */
export const HELI_HIT = [0, 0, 0, 0.2, 0.22, 0.26];

/** Hard cap on any single shot's hit probability: never laser-perfect. */
export const MAX_HIT = 0.55;

/** Minimum seconds between two police bullets landing on the player, per wanted level (no burst deaths). */
export const MIN_HIT_GAP = [1.2, 1.1, 0.9, 0.7, 0.55, 0.45];

/** Hit probability of one shot. All inputs are plain numbers so this stays unit-testable. */
export function hitChance(base, dist, targetSpeed, aimT, inVehicle = false, crouching = false) {
  if (!(base > 0)) return 0;
  const fd = Math.min(1.15, Math.max(0.45, 1.25 - dist / 40));           // close shots land more often
  const fm = Math.min(1, Math.max(0.35, 1 - targetSpeed / 20));           // fast targets are hard to hit
  const fw = Math.min(1, Math.max(0.35, 0.35 + aimT / 2.5));              // first shots after acquiring are wild
  const fv = inVehicle ? 1.25 : 1;                                         // a car is a big target
  const fc = crouching ? 0.85 : 1;
  return Math.min(MAX_HIT, base * fd * fm * fw * fv * fc);
}

/** Evasion duration for a wanted level. */
export const evadeSeconds = (stars) => TUNE.EVADE_BASE + TUNE.EVADE_PER_STAR * stars;

/** Search-area radius for a wanted level. */
export const searchRadius = (stars) => TUNE.SEARCH_BASE + TUNE.SEARCH_PER_STAR * stars;

/** Number of cruisers wanted at `stars` after `levelTime` seconds at that level. */
export function carsFor(stars, levelTime) {
  const L = LEVELS[Math.max(0, Math.min(5, stars | 0))];
  return levelTime >= LATER_T ? L.carsLater : L.cars;
}
