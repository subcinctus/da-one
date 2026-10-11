// Words: chapter story cards, aging lines, victory lines, game over, epilogue, credits, style descriptions.
// Tone: serious revenge, grounded; one dry line at the edge of each card.

/** Story card per chapter: short serious lines + one dry joke (shown last, quieter). */
export const CHAPTER_STORY = {
  laundromat: {
    lines: [
      'Tadao keeps the Golden Abacus books in the back of a laundromat on Pell Street.',
      'Every debt in the district passes across his counter. The deed to your father\'s dojo did, once.',
      'He was there that night. He counted the money twice.',
    ],
    joke: 'The machines take coins only. You brought fists.',
  },
  market: {
    lines: [
      'Madame Shu runs the night market. Every stall pays her, in cash or in silence.',
      'She held the door that night while the others went in.',
      'Tonight the lanterns are lit and the oil is hot.',
    ],
    joke: 'Do not eat the noodles. That is not a threat. It is a review.',
  },
  gym: {
    lines: [
      'Brick is the one who held Master Lan down.',
      'He trains at the Iron Lotus, a gym the syndicate bought the same week as the dojo.',
      'He is stronger than you. He has always been stronger than you.',
    ],
    joke: 'He has also never skipped leg day, and he will tell you about it.',
  },
  tower: {
    lines: [
      'Mr. Golden signed the forged deed with a gold pen. He still carries it.',
      'Forty floors up, he waits in a garden built on top of everyone else.',
      'Four names. This is the last one.',
    ],
    joke: 'Reception has been told you have an appointment. Technically, you do.',
  },
};

/** Victory card per boss: one serious line + one dry one. */
export const VICTORY = {
  tadao: ['Tadao closes his ledger for the last time.', 'His final invoice is marked "paid in full".'],
  madame_shu: ['The lanterns go out one by one along Canal Street.', 'The stalls will reopen under new management.'],
  brick: ['Brick goes down like a dropped barbell.', 'For the first time in eleven years, he takes a rest day.'],
  mr_golden: ['Mr. Golden sits down in his own garden and does not get up.', 'The deed is still in his pocket. You leave him the pen.'],
};

/** Aging card lines (Sifu): quiet, a little funny, tied to the age. Missing ages use the nearest lower entry. */
export const AGE_LINES = {
  21: 'Still young. The talisman is merely disappointed.',
  22: 'You find your first grey hair. You leave it there, as a warning.',
  23: 'Somewhere, a gym membership quietly lapses.',
  24: 'The floor is starting to feel familiar.',
  25: 'A quarter century. Most of it spent on floors.',
  26: 'You now stretch before fighting. You did not used to.',
  27: 'Your back makes a noise. Nobody comments. Everybody heard.',
  28: 'You begin to understand why Master Lan drank his tea so slowly.',
  29: 'The last year of your twenties. Spent, mostly, lying down.',
  30: 'Thirty. The talisman sends a card. It is unsigned.',
  31: 'Your knees file a formal complaint.',
  32: 'You now hold opinions about mattresses.',
  33: 'You warm up, cool down, and lie down. In that order.',
  34: 'You catch yourself saying "in my day". Your day was last Tuesday.',
  35: 'Half a lifetime of training. Half a minute on the floor.',
  36: 'Reading glasses would help. You refuse, on principle.',
  37: 'Your fists remember everything. Your keys, less so.',
  38: 'You groan getting up and groan sitting down. It is a lifestyle.',
  39: 'Forty is no longer a rumour.',
  40: 'Forty. Patience comes easier. So does sciatica.',
  41: 'Even your shadow looks tired.',
  42: 'You have started to respect a good chair.',
  43: 'Your joints forecast rain. They are rarely wrong.',
  44: 'You fight with less movement now. You call it economy.',
  45: 'Your hair has chosen a side. It is grey.',
  46: 'You take the stairs slower. You still take them.',
  47: 'Every blow lands heavier now. Yours too.',
  48: 'You hum Master Lan\'s old songs. Off key, the way he did.',
  49: 'The young ones call you "uncle" right before you hit them.',
  50: 'Fifty. Every movement is deliberate. Especially the groaning.',
  51: 'Your hands are steady. Your back has notes.',
  52: 'A dojo is a place you sweep. You understand that now.',
  53: 'You stop counting push-ups and start counting blessings. Briefly.',
  54: 'Revenge tastes the same at fifty-four. It just takes longer to chew.',
  55: 'You warm up for the warm-up.',
  56: 'The talisman is warmer. Or your hands are colder.',
  57: 'You nod off between rooms. Briefly. With dignity.',
  58: 'Your opponents look like children. Some of them are.',
  59: 'Your knees have stopped complaining. They have retained a lawyer.',
  60: 'Sixty. You move like water now. Slow, patient, mostly downhill.',
  61: 'The jade feels heavy on its cord.',
  62: 'Your grandmother\'s stance, your father\'s temper.',
  63: 'You remember every fall. Your body keeps the receipts.',
  64: 'Somewhere, a pension is waiting. It can wait.',
  65: 'Retirement age. You decline, again, in person.',
  66: 'You can hear the talisman counting.',
  67: 'The jade has gone pale. So have you.',
  68: 'Two more falls, maybe one. The talisman will not say.',
  69: 'One more fall and the jade goes quiet. Make it count.',
};

/** The aging card line for `age`. */
export function agingLine(age) {
  const a = Math.round(age);
  for (let k = Math.min(69, a); k >= 21; k--) if (AGE_LINES[k]) return AGE_LINES[k];
  return AGE_LINES[21];
}

/** Game over (age 70): the talisman stops. `replay` is shown when the restart age is 55+ (and an earlier chapter exists). */
export const GAME_OVER = {
  title: 'The talisman goes quiet.',
  lines: ['Even jade has its limits.', 'You begin the chapter again: younger, and considerably more annoyed.'],
  replay: 'Replay an earlier chapter from Chapters to arrive younger.',
};

/** After the final chapter. */
export const EPILOGUE = [
  'The dojo is quiet. Someone has swept it.',
  'You light incense for Master Lan, and one more, out of habit, for the child in the laundry basket.',
  'The talisman is cool against your chest. It has nothing left to say.',
  'In the spring you take a student. Her stance is terrible. You fix it, slowly.',
];

/** Credits roll (short, honest). */
export const CREDITS = [
  ['Last Stance', 'A revenge in four stances'],
  ['Design, code, poses, sound', 'A small swarm of agents and one patient orchestrator'],
  ['Built with', 'three.js, WebAudio, and nothing downloaded'],
  ['Inspired by', 'Sloclap\'s Absolver and Sifu'],
  ['Every mesh, pose and sound', 'Procedural. No assets were harmed.'],
  ['Special thanks', 'Master Lan, who would have corrected everyone\'s stance'],
];

/** Style select copy (abilities on the defend button). */
export const STYLE_COPY = {
  forsaken: {
    ability: 'Parry', tag: 'For the patient',
    how: 'Press Defend as the blow arrives. A clean parry turns it aside, staggers the attacker and fills your focus. Mistime it and you are open.',
  },
  kahlt: {
    ability: 'Absorb', tag: 'For the stubborn',
    how: 'Press Defend to brace. Blows land softer and cannot flinch you; strike back within a breath to heal what you absorbed. Guard breakers pierce it.',
  },
  windfall: {
    ability: 'Avoid', tag: 'For the restless',
    how: 'Press Defend to slip. Neutral ducks high strikes, left or right sidesteps thrusts and verticals, back hops over lows. A clean avoid opens a counter.',
  },
};

/** Rest point / small flavour lines. */
export const REST_LINES = [
  'You catch your breath.',
  'Your hands stop shaking. Mostly.',
  'Quiet, for a moment.',
  'The talisman settles.',
];
