// First-play tutorial: a chain of GTA-style help texts (hud.notify) that advance on what the player does
// (moving, stealing a car...) or after a while. Shown once per browser (localStorage) / per save.
const KEY = 'blockcity.tutorial.v1';

// Jobs hint: point at the nearest open mission giver (the one the first-game GPS route leads to).
const jobsText = (g, tail) => {
  let where = '.';
  try {
    const m = g.missions;
    const gv = m && !m.active && typeof m.nearestGiver === 'function' ? m.nearestGiver() : null;
    if (gv) {
      const wp = g.hud && g.hud.waypoint;
      const gps = wp && Math.hypot(wp.x - gv.poi.x, wp.z - gv.poi.z) < 2;
      where = gps ? ': follow the GPS to the ~y~' + gv.def.letter + '~s~ marker for your first job.' : ': the nearest is the ~y~' + gv.def.letter + '~s~ marker.';
    }
  } catch (e) { where = '.'; }
  return 'Yellow *job* markers earn cash' + where + ' ' + tail;
};

const HINTS = [
  { id: 'move', delay: 2.5, text: 'Welcome to *Block City*! Move with [W][A][S][D] and look around with the mouse.', touch: 'Welcome to *Block City*! Move with the left stick, drag on the right to look around.', advance: (s) => s.moved > 6 || s.t > 14 },
  { id: 'map', delay: 1.5,
    text: (g) => jobsText(g, '[M] map, [J] mission log.'),
    touch: (g) => jobsText(g, 'Tap the map button to see them all.'),
    advance: (s) => s.t > 12 },
  { id: 'sprint', delay: 1.5, text: 'Hold [Shift] to sprint and [Space] to jump. [C] switches the camera view.', touch: 'Tap the jump button to hop up blocks. The camera button switches views.', advance: (s) => s.t > 8 },
  { id: 'steal', delay: 1, text: 'See a car you like? Walk up to it and press [F] to *steal* it. [F] again to get out.', touch: 'See a car you like? Walk up to it and tap *F* to steal it.', advance: (s) => s.inCar || s.t > 22 },
  { id: 'drive', delay: 0.5, when: (s) => s.inCar, text: 'Drive with [W]/[S], steer with [A]/[D], [Space] is the handbrake. [N] changes the radio station.', touch: 'Drive with the left stick: up accelerates, down brakes, sideways steers. The *jump* button is the handbrake: drift!', advance: (s) => s.t > 9 },
  { id: 'inventory', delay: 2, text: 'Press [E] to open your inventory. Keys [1] to [9] select hotbar slots.', touch: 'Tap the bag button for your inventory, tap hotbar slots to select items.', advance: (s) => s.t > 9 },
  { id: 'mine', delay: 2, text: 'Hold [LMB] on a block to *mine* it and [RMB] to *place* the selected block. Natural ores like *gold* and *diamond* pay cash!', touch: 'Hold *ATK* on a block to *mine* it, tap *AIM* to *place* the selected block. Natural ores like *gold* and *diamond* pay cash!', advance: (s) => s.t > 10 },
  { id: 'shops', delay: 2, text: 'Shops: ~r~Ammu-Blocks~s~ for guns, ~o~Block Depot~s~ for blocks, ~g~Pay\'n\'Spray~s~ to lose the cops, the ~b~safehouse~s~ to save.', touch: 'Shops: ~r~Ammu-Blocks~s~ for guns, ~o~Block Depot~s~ for blocks, ~g~Pay\'n\'Spray~s~ to lose the cops, the ~b~safehouse~s~ to save.', advance: (s) => s.t > 9 },
];
const DRIVE_IDX = HINTS.findIndex((h) => h.id === 'drive');

export class Tutorial {
  constructor(game) {
    this.game = game;
    this.idx = 0;
    this.shown = false;     // current hint shown
    this.t = 0;
    this.moved = 0;
    this.done = false;
    this.active = false;
    this._last = null;
    this._sawCar = false;
    this._pendingDrive = false;
  }

  /** Start the chain unless it was completed before. A fresh game also gets a GPS route to the nearest job. */
  start(force = false) {
    this._gpsFirstJob();
    if (!force && (this.done || this._storedDone())) { this.done = true; return; }
    const p = this.game.params;
    if (!force && p && (p.get('tutorial') === '0' || p.get('notutorial'))) { this.done = true; return; }
    this.active = true;
    this.idx = 0;
    this.shown = false;
    this.t = 0;
  }

  /** Fresh game (no mission passed, none running): point the GPS at the nearest job giver (clears on arrival). */
  _gpsFirstJob() {
    const g = this.game;
    const m = g.missions;
    if (!m || m.active || !(m.completed && m.completed.size === 0)) return;
    const hud = g.hud;
    if (!hud || typeof hud.setWaypoint !== 'function' || hud.waypoint) return;
    let gv = null;
    try { gv = typeof m.nearestGiver === 'function' ? m.nearestGiver() : null; } catch (e) { gv = null; }
    if (gv && gv.poi) hud.setWaypoint({ x: gv.poi.x, z: gv.poi.z }, true);
  }

  _storedDone() {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  finish() {
    this.active = false;
    this.done = true;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
  }

  update(dt) {
    if (!this.active) return;
    const g = this.game;
    const p = g.player;
    if (!p || !p.position) return;
    if (this._last) this.moved += Math.hypot(p.position.x - this._last.x, p.position.z - this._last.z);
    this._last = { x: p.position.x, z: p.position.z };
    const inCar = !!p.inVehicle;
    if (inCar) this._sawCar = true;
    this.t += dt;
    // late driving tips the first time the player gets a car
    if (this._pendingDrive && inCar && this.idx > DRIVE_IDX) {
      this._pendingDrive = false;
      this._notify(HINTS[DRIVE_IDX]);
    }
    const h = HINTS[this.idx];
    if (!h) { if (!this._pendingDrive) this.finish(); return; }
    const state = { t: this.t, moved: this.moved, inCar };
    if (!this.shown) {
      if (this.t < h.delay) return;
      if (h.when && !h.when(state)) {
        // conditional hint not applicable yet (e.g. driving tips before ever entering a car): show it later
        if (h.id === 'drive') this._pendingDrive = true;
        this.idx++;
        this.t = 0;
        return;
      }
      this._show(h);
      return;
    }
    if (h.advance(state)) {
      this.idx++;
      this.t = 0;
      this.shown = false;
      this.moved = 0;
    }
  }

  _show(h) {
    this.shown = true;
    this.t = 0;
    this._notify(h);
  }

  _notify(h) {
    const g = this.game;
    const touch = !!(g.hud && g.hud.touchMode);
    let text = touch && h.touch ? h.touch : h.text;
    if (typeof text === 'function') { try { text = text(g); } catch (e) { text = ''; } }
    if (!text) return;
    try { g.hud?.notify?.(text, { duration: 7.5, color: '#f5c518' }); } catch (e) { /* hud stub */ }
  }
}
