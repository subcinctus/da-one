// Story frame + chapter list. Tone: serious revenge story, dry humour at the edges (boss quirks, deadpan lines).
export const GAME_TITLE = 'LAST STANCE';

export const PREMISE = [
  'Seven years ago the Golden Abacus syndicate bought the Lan family dojo with a forged deed and a very real fist.',
  'Master Lan did not survive the negotiation.',
  'You were thirteen. You hid in the laundry basket. You have not stopped training since.',
  'Four names. Four stances. One jade talisman that will not let you stay dead.',
];

/**
 * Death ages you (the talisman revives you older). Age 70 = final death: the chapter restarts at your entry age
 * (with slack: three more deaths always fit, see game/progress.js). Boss names carry a quoted epithet
 * ('Name "Epithet"'): ui/hud.js splitBossName shows it on the title card and the boss bar; speakers and the victory
 * card use the plain name.
 */
export const AGE = { start: 20, max: 70 };

export const CHAPTERS = [
  {
    id: 'laundromat', index: 1, title: 'The Laundromat', subtitle: 'Spin Cycle',
    boss: { id: 'tadao', name: 'Tadao "The Accountant"', stance: 'FR',
      blurb: 'Soft-spoken. Fights with tidy, efficient strikes. Sends you an itemised bill for every punch.' },
    palette: 'mint tiles, cream walls, chrome machines, morning light', rooms: 3,
  },
  {
    id: 'market', index: 2, title: 'The Night Market', subtitle: 'Hot Oil',
    boss: { id: 'madame_shu', name: 'Madame Shu "The Landlady"', stance: 'FL',
      blurb: 'Runs every stall on Canal Street. Her kitchen is terrible. Her kicks are not.' },
    palette: 'warm lantern orange, deep teal canopies, wet stone (no fog)', rooms: 3,
  },
  {
    id: 'gym', index: 3, title: 'Iron Lotus Gym', subtitle: 'Leg Day',
    boss: { id: 'brick', name: 'Brick "The Wall"', stance: 'BR',
      blurb: 'Has never skipped leg day. Or any day. Communicates mainly in grunts and reps.' },
    palette: 'raw concrete, red mats, skylight beams, chalk dust only on hits', rooms: 3,
  },
  {
    id: 'tower', index: 4, title: 'Abacus Tower', subtitle: 'Final Negotiation',
    boss: { id: 'mr_golden', name: 'Mr. Golden "The Developer"', stance: 'BL', allStances: true,
      blurb: 'Property developer. Collector of dojos. Would like you to sign something before he kills you.' },
    palette: 'rooftop garden at golden hour, pale stone, glass, distant skyline', rooms: 3,
  },
];
export const chapterById = (id) => CHAPTERS.find((c) => c.id === id) || null;
