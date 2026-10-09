// Weapon definitions. Owned by the COMBAT agent (may tune numbers / add weapons; never rename existing ids or fields).
//   kind: 'melee' | 'hitscan' | 'projectile' (rocket) | 'throw' (grenade)
//   damage per bullet/pellet (melee: per hit), rate = shots per second, mag = magazine size (0 = no ammo),
//   reload seconds, spread radians (cone half-angle), range metres, auto = hold to fire,
//   pellets (shotgun), zoom (FOV divisor while aiming), price ($ in gun shop), ammoPrice ($ per magazine refill),
//   blastRadius / blastPower for explosives (power compared to block.blast), icon = short emoji for HUD.
export const WEAPONS = {
  fist:    { id: 'fist', name: 'Fists', kind: 'melee', damage: 12, rate: 2.5, range: 2.4, mag: 0, icon: '👊', price: 0 },
  bat:     { id: 'bat', name: 'Baseball Bat', kind: 'melee', damage: 34, rate: 1.6, range: 2.8, mag: 0, icon: '🏏', price: 150 },
  pistol:  { id: 'pistol', name: 'Pistol', kind: 'hitscan', damage: 26, rate: 4, mag: 12, reload: 1.2, spread: 0.012, range: 140, auto: false, zoom: 1.3, icon: '🔫', price: 300, ammoPrice: 40 },
  smg:     { id: 'smg', name: 'SMG', kind: 'hitscan', damage: 15, rate: 13, mag: 30, reload: 1.6, spread: 0.035, range: 110, auto: true, zoom: 1.3, icon: '🔫', price: 1100, ammoPrice: 80 },
  shotgun: { id: 'shotgun', name: 'Pump Shotgun', kind: 'hitscan', damage: 13, pellets: 9, rate: 1.1, mag: 6, reload: 2.3, spread: 0.08, range: 45, auto: false, zoom: 1.2, icon: '🔫', price: 1500, ammoPrice: 90 },
  rifle:   { id: 'rifle', name: 'Assault Rifle', kind: 'hitscan', damage: 30, rate: 9, mag: 30, reload: 2.0, spread: 0.018, range: 200, auto: true, zoom: 1.6, icon: '🔫', price: 3000, ammoPrice: 120 },
  sniper:  { id: 'sniper', name: 'Sniper Rifle', kind: 'hitscan', damage: 140, rate: 0.8, mag: 5, reload: 2.6, spread: 0.0015, range: 400, auto: false, zoom: 5, icon: '🎯', price: 5000, ammoPrice: 150 },
  rpg:     { id: 'rpg', name: 'Rocket Launcher', kind: 'projectile', damage: 220, rate: 0.6, mag: 1, reload: 2.4, spread: 0.004, range: 300, auto: false, zoom: 1.5, speed: 60, blastRadius: 5.5, blastPower: 4, icon: '🚀', price: 9000, ammoPrice: 500 },
  grenade: { id: 'grenade', name: 'Grenade', kind: 'throw', damage: 160, rate: 1.2, mag: 1, reload: 0.6, range: 40, auto: false, fuse: 2.5, blastRadius: 4.5, blastPower: 3, icon: '💣', price: 400, ammoPrice: 400 },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/** Weapons that can be bought in the gun shop, in display order. */
export const SHOP_WEAPONS = ['bat', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'rpg', 'grenade'];
