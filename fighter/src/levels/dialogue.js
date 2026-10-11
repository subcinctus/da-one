// Every spoken line in the fights (FIGHTER.md §11): boss intros (the game's signature humour: serious delivery, dry
// jokes), phase-2 lines, last words, rude-interruption lines, and sparing thug one-liners per chapter.
// Payload format of the 'dialogue' event: { speaker, text, mood, bossId?, bark?, duration }.

/** Display names for speakers. */
export const SPEAKERS = { tadao: 'Tadao', madame_shu: 'Madame Shu', brick: 'Brick', mr_golden: 'Mr. Golden' };

/** Boss intros: 2-4 lines, played one by one while the camera holds on the boss. */
export const BOSS_INTROS = {
  tadao: [
    { text: 'Ah. The Lan boy. I have your file.', mood: 'calm' },
    { text: 'Twelve staff, two dryers, one ceiling fan. Itemised. Please initial each page.', mood: 'dry' },
    { text: 'From here on, every punch is billed separately. Keep your receipts.', mood: 'calm' },
  ],
  madame_shu: [
    { text: 'You came all this way. Sit. Eat something.', mood: 'warm' },
    { text: 'The noodles are terrible. Everyone tells me. Nobody tells me twice.', mood: 'dry' },
    { text: 'The kitchen closes when you hit the floor.', mood: 'threat' },
  ],
  brick: [
    { text: 'Hnnh.', mood: 'grunt' },
    { text: '(He chalks his hands. Twice. Then once more, for you.)', mood: 'aside' },
    { text: 'Membership. Overdue.', mood: 'grunt' },
  ],
  mr_golden: [
    { text: 'The Lan boy. All grown up, and still trespassing.', mood: 'smug' },
    { text: 'Before we begin, a formality. Sign here, here, and initial here. It says you lost.', mood: 'dry' },
    { text: 'No? A pity. I would have framed it next to the deed.', mood: 'smug' },
    { text: 'Very well. Let us negotiate.', mood: 'threat' },
  ],
};

/** Phase 2 (50% health): one short line. */
export const BOSS_PHASE2 = {
  tadao: { text: 'I see. Let me revise the estimate.', mood: 'cold' },
  madame_shu: { text: 'Fine. No more free refills.', mood: 'angry' },
  brick: { text: 'Set two.', mood: 'grunt' },
  mr_golden: { text: 'I am withdrawing the offer.', mood: 'cold' },
};

/** Last words when the boss falls. */
export const BOSS_DEFEAT = {
  tadao: { text: 'Put it... on my tab.', mood: 'weak' },
  madame_shu: { text: 'Tell them... the broth was fine.', mood: 'weak' },
  brick: { text: 'Should have... done cardio.', mood: 'weak' },
  mr_golden: { text: 'The pen... was a gift.', mood: 'weak' },
};

/** Hit during the intro: the boss skips the formalities. */
export const BOSS_RUDE = {
  tadao: { text: 'That one was off the books. I am adding interest.', mood: 'cold' },
  madame_shu: { text: 'No manners. You can wash the woks after.', mood: 'angry' },
  brick: { text: 'Hnnh. Rude.', mood: 'grunt' },
  mr_golden: { text: 'Assault before the paperwork. My lawyers will love you.', mood: 'smug' },
};

/** Thug one-liners when a room starts (chapter flavour). Used sparingly. */
export const ROOM_LINES = {
  laundromat: [
    'We\'re closed. Says so on the door.',
    'Delicates go in the other machine.',
    'Mr. Tadao is going to bill you for this.',
    'You tracked dirt on a clean floor.',
  ],
  market: [
    'No table for one.',
    'You don\'t look like the health inspector.',
    'Madame Shu says no refunds. On anything.',
    'Kitchen\'s closed. Your face is open.',
  ],
  gym: [
    'Members only.',
    'Your form is terrible. Let me fix it.',
    'Brick hasn\'t missed a day in eleven years.',
    'Spot me? No? Okay.',
  ],
  tower: [
    'Do you have an appointment?',
    'Visitors sign in at the lobby.',
    'Mr. Golden is in a meeting. You\'re the meeting.',
    'Please hold. Your beating is important to us.',
  ],
};

/** Circling taunts (rare). */
export const TAUNT_LINES = [
  'Come on, then.',
  'Is that it?',
  'You\'re breathing hard.',
  'Take your time. We get paid by the hour.',
];

/** When the player is knocked down (rare). */
export const KNOCKDOWN_LINES = ['Stay down.', 'Floor\'s comfortable, right?', 'That\'s the spirit. Lie there.'];

/** Reading time for a line (seconds). */
export function lineDuration(text) {
  return Math.min(5.5, Math.max(1.8, 0.9 + 0.05 * String(text || '').length));
}
