// The four stances (Absolver-style quadrants). Every attack starts in one stance and ends in another.
//   front = chest facing the opponent; back = torso turned away (~130-160 deg), the opponent sees your back/shoulder.
//   lead  = which foot is forward (right foot forward => 'R').
// HUD / stick layout: up = front, down = back, right = R, left = L (RT/R2 + right stick flick picks a stance).
export const STANCES = ['FR', 'FL', 'BR', 'BL'];
export const STANCE_INFO = {
  FR: { id: 'FR', name: 'Front Right', facing: 'front', lead: 'R', stick: [1, 1] },
  FL: { id: 'FL', name: 'Front Left', facing: 'front', lead: 'L', stick: [-1, 1] },
  BR: { id: 'BR', name: 'Back Right', facing: 'back', lead: 'R', stick: [1, -1] },
  BL: { id: 'BL', name: 'Back Left', facing: 'back', lead: 'L', stick: [-1, -1] },
};
/** Mirror partner (same facing, other lead foot). */
export const MIRROR_STANCE = { FR: 'FL', FL: 'FR', BR: 'BL', BL: 'BR' };
/** Default starting stance. */
export const DEFAULT_STANCE = 'FR';

/** Defensive combat styles (choose one). Each maps the defend button (B / Circle) to its ability. */
export const STYLES = {
  forsaken: { id: 'forsaken', name: 'Forsaken', ability: 'parry', desc: 'Timed parry. Deflect a strike and leave the attacker open.' },
  kahlt: { id: 'kahlt', name: 'Kahlt', ability: 'absorb', desc: 'Absorb blows without flinching and heal on the counter. Guard-breaking strikes pierce it.' },
  windfall: { id: 'windfall', name: 'Windfall', ability: 'avoid', desc: 'Slip strikes: sidestep with the stick, duck by default.' },
};
