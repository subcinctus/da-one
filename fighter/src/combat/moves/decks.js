// Combat decks (8 slots: main + alt per stance) and named showcase strings.
// A move may only sit in a slot of its own start stance. The starter deck's MAIN attacks loop through all four
// stances (FR -> BR -> FL -> BL -> FR); the alternates branch off that loop.

/** The player's starting deck. Mains: Snap Back Fist -> Reverse Palm -> Reverse Elbow -> Reverse Palm -> ... */
export const STARTER_DECK = {
  FR: { main: 'fr_snap_backfist', alt: 'fr_crossing_straight' },
  BR: { main: 'br_reverse_palm', alt: 'br_dragon_tail' },
  FL: { main: 'fl_reverse_elbow', alt: 'fl_liver_hook' },
  BL: { main: 'bl_reverse_palm', alt: 'bl_spinning_backfist' },
};

/**
 * Learned-but-unequipped starter moves: a new run knows these too, so the first rest point offers a real choice.
 * One per stance, each ending in a different stance (FL->FR, FR->BR, BR->FL, BL->FR) so swapping one in reroutes a string.
 */
export const STARTER_EXTRA = ['fl_twin_sparrows', 'fr_gate_kick', 'br_flying_knee', 'bl_scissor_kicks'];

/** Named decks for enemy archetypes and bosses (AI: `deck[stance].main / .alt`). */
export const ENEMY_DECKS = {
  thug: {
    FR: { main: 'fr_snap_jab', alt: 'fr_shin_cutter' },
    FL: { main: 'fl_snap_jab', alt: 'fl_crossing_straight' },
    BR: { main: 'br_whip_fist', alt: 'br_reverse_palm' },
    BL: { main: 'bl_whip_fist', alt: 'bl_reverse_palm' },
  },
  brawler: {
    FR: { main: 'fr_liver_hook', alt: 'fr_turning_backfist' },
    FL: { main: 'fl_liver_hook', alt: 'fl_wheel_kick' },
    BR: { main: 'br_mule_kick', alt: 'br_temple_bell' },
    BL: { main: 'bl_mule_kick', alt: 'bl_spinning_heel' },
  },
  swift: {
    FR: { main: 'fr_snap_backfist', alt: 'fr_snap_jab' },
    FL: { main: 'fl_twin_sparrows', alt: 'fl_turning_backfist' },
    BR: { main: 'br_spinning_backfist', alt: 'br_flying_knee' },
    BL: { main: 'bl_scissor_kicks', alt: 'bl_whip_fist' },
  },
  heavy: {
    FR: { main: 'fr_gate_kick', alt: 'fr_falling_axe' },
    FL: { main: 'fl_gate_kick', alt: 'fl_wheel_kick' },
    BR: { main: 'br_temple_bell', alt: 'br_spinning_heel' },
    BL: { main: 'bl_iron_palm', alt: 'bl_dragon_tail' },
  },
  tadao: {
    FR: { main: 'tadao_compound_interest', alt: 'tadao_late_fee' },
    FL: { main: 'fl_snap_jab', alt: 'fl_crossing_straight' },
    BR: { main: 'br_whip_fist', alt: 'br_reverse_palm' },
    BL: { main: 'bl_reverse_palm', alt: 'bl_whip_fist' },
  },
  madame_shu: {
    FL: { main: 'fl_wheel_kick', alt: 'shu_last_order' },
    FR: { main: 'fr_shin_cutter', alt: 'fr_gate_kick' },
    BR: { main: 'br_dragon_tail', alt: 'shu_wok_toss' },
    BL: { main: 'bl_dragon_tail', alt: 'bl_spinning_heel' },
  },
  brick: {
    BR: { main: 'brick_bench_press', alt: 'brick_deadlift' },
    FR: { main: 'fr_liver_hook', alt: 'fr_falling_axe' },
    FL: { main: 'fl_liver_hook', alt: 'fl_crossing_straight' },
    BL: { main: 'bl_mule_kick', alt: 'bl_iron_palm' },
  },
  mr_golden: {
    BL: { main: 'golden_handshake', alt: 'bl_spinning_backfist' },
    BR: { main: 'br_spinning_backfist', alt: 'golden_hostile_takeover' },
    FR: { main: 'fr_snap_backfist', alt: 'fr_turning_backfist' },
    FL: { main: 'fl_twin_sparrows', alt: 'fl_turning_backfist' },
  },
};

/** Optional phase-2 boss decks (more signature pressure). AI may swap to these at 50% health. */
export const BOSS_PHASE2_DECKS = {
  tadao: { ...ENEMY_DECKS.tadao, FL: { main: 'fl_twin_sparrows', alt: 'fl_liver_hook' }, BR: { main: 'br_whip_fist', alt: 'br_mule_kick' } },
  madame_shu: { ...ENEMY_DECKS.madame_shu, FR: { main: 'fr_snap_backfist', alt: 'fr_falling_axe' }, BL: { main: 'bl_scissor_kicks', alt: 'bl_spinning_heel' } },
  brick: { ...ENEMY_DECKS.brick, FR: { main: 'fr_gate_kick', alt: 'fr_falling_axe' }, BL: { main: 'bl_iron_palm', alt: 'bl_spinning_heel' } },
  mr_golden: { ...ENEMY_DECKS.mr_golden, FR: { main: 'fr_crossing_straight', alt: 'fr_falling_axe' }, FL: { main: 'fl_reverse_elbow', alt: 'fl_wheel_kick' } },
};

/**
 * Showcase strings for the UI (each move starts in the stance the previous one ended in; max 3 = one string).
 * `routeInputs(route, deck)` tells which button plays each step with a given deck.
 */
export const COMBO_ROUTES = [
  { id: 'river_step', name: 'River Step', desc: 'Straight, turn, turn again. The river does not stop to ask.',
    moves: ['fr_crossing_straight', 'fl_turning_backfist', 'br_spinning_backfist'] },
  { id: 'spin_cycle', name: 'Spin Cycle', desc: 'The starter deck on repeat. Knuckles, palm, elbow; rinse.',
    moves: ['fr_snap_backfist', 'br_reverse_palm', 'fl_reverse_elbow'] },
  { id: 'floor_plan', name: 'Floor Plan', desc: 'Body, head, then the floor. In that order, every time.',
    moves: ['fr_liver_hook', 'fl_wheel_kick', 'br_dragon_tail'] },
  { id: 'paper_lantern', name: 'Paper Lantern', desc: 'Two hands to light it, two kicks to send it off.',
    moves: ['fl_twin_sparrows', 'fr_gate_kick', 'br_mule_kick'] },
  { id: 'long_way_round', name: 'The Long Way Round', desc: 'A full turn, a jump, and a heel from the ceiling.',
    moves: ['br_spinning_heel', 'bl_scissor_kicks', 'fr_falling_axe'] },
  { id: 'rent_is_due', name: 'Rent Is Due', desc: 'Iron palm, body hook, a kick to the shin. Itemised.',
    moves: ['bl_iron_palm', 'fl_liver_hook', 'fr_shin_cutter'] },
];

/** For each step of a route, 'main' | 'alt' | null (not slotted) for the given deck. */
export function routeInputs(route, deck, moves) {
  const ids = Array.isArray(route) ? route : route?.moves || [];
  return ids.map((id) => {
    const st = moves?.[id]?.start;
    const slot = st && deck?.[st];
    return slot?.main === id ? 'main' : slot?.alt === id ? 'alt' : null;
  });
}
