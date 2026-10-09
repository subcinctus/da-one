// Weapon definitions. Owned by the COMBAT agent (may tune numbers / add weapons; never rename existing ids or fields).
//   kind: 'melee' | 'hitscan' | 'projectile' (rocket) | 'throw' (grenade)
//   damage per bullet/pellet (melee: per hit), rate = shots per second, mag = magazine size (0 = no ammo),
//   reload seconds, spread radians (cone half-angle, hip fire), range metres, auto = hold to fire,
//   pellets (shotgun), zoom (FOV divisor while aiming), price ($ in gun shop), ammoPrice ($ per magazine refill),
//   blastRadius / blastPower for explosives (power compared to block.blast), icon = short emoji for HUD.
//
// Extra tuning fields (combat only, all optional):
//   sound        one-shot played on fire (§4.4 names)
//   recoil       camera pitch kick per shot (radians; camera keeps ~35% of it, the rest springs back)
//   recoilYaw    random horizontal kick amplitude (radians)
//   shake        camera trauma added per shot (0..1)
//   hipSpread    spread used when NOT aiming (defaults to `spread`); aiming uses spread * aimSpread
//   aimSpread    multiplier applied to the spread while aiming (default 0.45)
//   bloom        spread growth per shot during sustained fire (fraction of the base spread)
//   falloffStart metres after which bullet damage starts dropping (linear to falloffMin at `range`)
//   falloffMin   damage multiplier reached at max range
//   headshot     damage multiplier for head hits on humanoids
//   knockback    push (m/s) applied to the target on hit (melee / heavy guns)
//   tracer       tracer colour (hex)
//   flash        muzzle light intensity scale
//   driveBy      can be fired from a car window
//   shellReload  seconds per shell for one-at-a-time reloads (pump shotgun; firing interrupts the reload)
//   throwSpeed   grenade launch speed (m/s); fuse seconds
export const WEAPONS = {
  fist:    { id: 'fist', name: 'Fists', kind: 'melee', damage: 12, rate: 2.5, range: 2.4, mag: 0, icon: '👊', price: 0,
    knockback: 2.2 },
  bat:     { id: 'bat', name: 'Baseball Bat', kind: 'melee', damage: 34, rate: 1.6, range: 2.8, mag: 0, icon: '🏏', price: 150,
    knockback: 5.6, auto: true },
  pistol:  { id: 'pistol', name: 'Pistol', kind: 'hitscan', damage: 26, rate: 5, mag: 12, reload: 1.25, spread: 0.014, range: 140, auto: false, zoom: 1.3, icon: '🔫', price: 300, ammoPrice: 40,
    sound: 'gunshot_pistol', recoil: 0.028, recoilYaw: 0.012, shake: 0.05, aimSpread: 0.4, bloom: 0.55, falloffStart: 45, falloffMin: 0.55, headshot: 2, tracer: 0xffe2a0, flash: 1, driveBy: true },
  smg:     { id: 'smg', name: 'SMG', kind: 'hitscan', damage: 15, rate: 13, mag: 30, reload: 1.7, spread: 0.034, range: 110, auto: true, zoom: 1.3, icon: '🔫', price: 1100, ammoPrice: 80,
    sound: 'gunshot_smg', recoil: 0.013, recoilYaw: 0.011, shake: 0.03, aimSpread: 0.5, bloom: 0.16, falloffStart: 35, falloffMin: 0.5, headshot: 2, tracer: 0xffd27a, flash: 0.8, driveBy: true },
  shotgun: { id: 'shotgun', name: 'Pump Shotgun', kind: 'hitscan', damage: 13, pellets: 9, rate: 1.1, mag: 6, reload: 2.3, spread: 0.075, range: 45, auto: false, zoom: 1.2, icon: '🔫', price: 1500, ammoPrice: 90,
    sound: 'gunshot_shotgun', recoil: 0.075, recoilYaw: 0.02, shake: 0.17, aimSpread: 0.75, bloom: 0, falloffStart: 10, falloffMin: 0.25, headshot: 1.5, knockback: 0.7, tracer: 0xffc070, flash: 1.6, shellReload: 0.42 },
  rifle:   { id: 'rifle', name: 'Assault Rifle', kind: 'hitscan', damage: 30, rate: 9, mag: 30, reload: 2.0, spread: 0.018, range: 200, auto: true, zoom: 1.6, icon: '🔫', price: 3000, ammoPrice: 120,
    sound: 'gunshot_rifle', recoil: 0.018, recoilYaw: 0.012, shake: 0.04, aimSpread: 0.4, bloom: 0.2, falloffStart: 90, falloffMin: 0.6, headshot: 2, tracer: 0xffe08a, flash: 1.1 },
  sniper:  { id: 'sniper', name: 'Sniper Rifle', kind: 'hitscan', damage: 140, rate: 0.8, mag: 5, reload: 2.6, spread: 0.0015, range: 400, auto: false, zoom: 5, icon: '🎯', price: 5000, ammoPrice: 150,
    sound: 'gunshot_sniper', recoil: 0.09, recoilYaw: 0.015, shake: 0.14, hipSpread: 0.045, aimSpread: 1, bloom: 0, falloffStart: 400, falloffMin: 1, headshot: 2.5, knockback: 3.5, tracer: 0xfff0c0, flash: 1.5 },
  rpg:     { id: 'rpg', name: 'Rocket Launcher', kind: 'projectile', damage: 220, rate: 0.6, mag: 1, reload: 2.4, spread: 0.004, range: 300, auto: false, zoom: 1.5, speed: 60, blastRadius: 5.5, blastPower: 4, icon: '🚀', price: 9000, ammoPrice: 500,
    sound: 'rocket_launch', recoil: 0.06, recoilYaw: 0.01, shake: 0.24, hipSpread: 0.012, aimSpread: 0.35, flash: 1.4 },
  grenade: { id: 'grenade', name: 'Grenade', kind: 'throw', damage: 160, rate: 1.2, mag: 1, reload: 0.6, range: 40, auto: false, fuse: 2.5, blastRadius: 4.5, blastPower: 3, icon: '💣', price: 400, ammoPrice: 400,
    throwSpeed: 18 },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/** Weapons that can be bought in the gun shop, in display order. */
export const SHOP_WEAPONS = ['bat', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'rpg', 'grenade'];

/** True for weapons that shoot (hitscan or rockets). */
export const isGun = (id) => !!(WEAPONS[id] && (WEAPONS[id].kind === 'hitscan' || WEAPONS[id].kind === 'projectile'));
