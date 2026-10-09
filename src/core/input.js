// Unified input: keyboard + mouse (pointer lock with a no-lock fallback) + virtual (touch) controls,
// exposed as named ACTIONS so gameplay code never reads raw keys.
//
//   input.down('forward')        held this frame
//   input.pressed('jump')        went down since last frame (edge)
//   input.released('attack')     went up since last frame (edge)
//   input.moveAxis()             {x: strafe right(+)/left(-), y: forward(+)/back(-)}, length <= 1
//   input.look                   {dx, dy} pixel deltas accumulated this frame (mouse + touch). dx>0 = look right, dy>0 = look down
//   input.wheel                  wheel delta this frame (+ = scrolled down / next slot)
//
// While game.uiOpen (a menu/panel is open) every gameplay query returns false/zero.
// Pass `true` as the 2nd argument (input.pressed('pause', true)) to read an action even while UI is open.
//
// Touch/virtual controls (ui/touch.js) feed the same state through setVirtual / setVirtualAxis / addLook.

export const KEYMAP = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],                    // on foot: jump/swim up. car: handbrake. heli: ascend
  sprint: ['ShiftLeft', 'ShiftRight'], // on foot: sprint. heli: descend
  crouch: ['ControlLeft', 'KeyX'],     // on foot: sneak (slow, no fall off edges)
  enterVehicle: ['KeyF'],              // enter / exit / carjack
  camera: ['KeyC', 'KeyV'],            // cycle camera mode (1st / 3rd person / far)
  inventory: ['KeyE'],                 // open/close inventory
  reload: ['KeyR'],
  horn: ['KeyH'],                      // vehicle horn (police car: toggles siren)
  lights: ['KeyL'],                    // vehicle headlights
  radio: ['KeyN'],                     // vehicle: next radio station
  grenade: ['KeyG'],                   // throw grenade (if owned)
  drop: ['KeyQ'],                      // drop/cycle weapon (optional)
  map: ['KeyM'],                       // full-screen map
  missions: ['KeyJ'],                  // mission log / help
  pause: ['Escape', 'KeyP'],
  slot1: ['Digit1'], slot2: ['Digit2'], slot3: ['Digit3'], slot4: ['Digit4'], slot5: ['Digit5'],
  slot6: ['Digit6'], slot7: ['Digit7'], slot8: ['Digit8'], slot9: ['Digit9'],
  attack: ['Mouse0'],                  // LMB: shoot / punch / mine
  aim: ['Mouse2'],                     // RMB: aim (weapon) / place block (block item)
  pick: ['Mouse1'],                    // MMB: pick block (creative)
};

const ALWAYS = new Set(['pause', 'inventory', 'map', 'missions']); // toggle keys that must work while UI is open (still need force=true)

export class Input {
  constructor(game) {
    this.game = game;
    this.canvas = game.renderer.domElement;
    this._down = new Set();      // raw codes currently held (keyboard + 'Mouse0'..)
    this._pressed = new Set();   // raw codes pressed this frame
    this._released = new Set();
    this._virtual = new Map();   // action -> bool (touch)
    this._vPressed = new Set();
    this._vReleased = new Set();
    this._vAxis = { x: 0, y: 0 };
    this.look = { dx: 0, dy: 0 };
    this.wheel = 0;
    this.locked = false;
    this.lockFailed = false;     // true once pointer lock is known to be unavailable (sandboxed iframe, unsupported) -> fallback look
    this.touchMode = false;      // set by touch controls: pointer lock is never requested
    this._lockFailures = 0;      // consecutive failed requests (a single failure can just be the browser's re-lock cooldown)
    this.mouseX = 0; this.mouseY = 0; // last client mouse position
    this._codeToActions = new Map();
    for (const [action, codes] of Object.entries(KEYMAP)) {
      for (const c of codes) {
        if (!this._codeToActions.has(c)) this._codeToActions.set(c, []);
        this._codeToActions.get(c).push(action);
      }
    }
    this._bind();
  }

  get blocked() { return !!this.game.uiOpen; }

  _isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  _bind() {
    const c = this.canvas;
    window.addEventListener('keydown', (e) => {
      if (this._isTyping(e)) return;
      if (this._codeToActions.has(e.code) || e.code === 'Tab') e.preventDefault();
      if (!this._down.has(e.code)) this._pressed.add(e.code);
      this._down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      if (this._down.has(e.code)) this._released.add(e.code);
      this._down.delete(e.code);
    });
    window.addEventListener('blur', () => this.clear());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      const code = 'Mouse' + e.button;
      if (!this._down.has(code)) this._pressed.add(code);
      this._down.add(code);
      if (!this.locked && this.game.state === 'playing' && !this.game.uiOpen) this.requestLock();
    });
    window.addEventListener('mouseup', (e) => {
      const code = 'Mouse' + e.button;
      if (this._down.has(code)) this._released.add(code);
      this._down.delete(code);
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      if (this.game.uiOpen) return;
      // With pointer lock: always. Without (fallback): only when the cursor is over the game canvas.
      if (this.locked || (this.lockFailed && e.target === c)) {
        // Clamp absurd spikes some browsers emit on lock changes.
        const dx = Math.max(-200, Math.min(200, e.movementX || 0));
        const dy = Math.max(-200, Math.min(200, e.movementY || 0));
        this.look.dx += dx; this.look.dy += dy;
      }
    });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.wheel += Math.sign(e.deltaY); }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === c;
      if (this.locked) this._lockFailures = 0;
      if (was !== this.locked) this.game.events.emit('pointerLockChange', { locked: this.locked });
    });
    document.addEventListener('pointerlockerror', () => this._lockError(null));
  }

  /**
   * A lock request failed. Sandboxed / unsupported environments switch to fallback look immediately;
   * anything else (e.g. Chrome's ~1 s cooldown right after the user pressed Esc) only counts as a strike,
   * and three consecutive strikes switch to fallback look.
   */
  _lockError(err) {
    const msg = String((err && (err.name + ' ' + err.message)) || '').toLowerCase();
    if (msg.includes('sandbox') || msg.includes('notsupported') || msg.includes('not supported')) { this.lockFailed = true; return; }
    if (++this._lockFailures >= 3) this.lockFailed = true;
  }

  /** Request pointer lock (must be called from a user gesture). Silently falls back if unsupported. */
  requestLock() {
    if (this.locked || this.lockFailed || this.touchMode) return;
    const c = this.canvas;
    if (!c.requestPointerLock) { this.lockFailed = true; return; }
    try {
      const p = c.requestPointerLock();
      if (p && p.catch) p.catch((e) => this._lockError(e));
    } catch (e) { this._lockError(e); }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  _actionCodes(action) { return KEYMAP[action] || []; }

  down(action, force = false) {
    if (this.blocked && !force) return false;
    if (this._virtual.get(action)) return true;
    for (const c of this._actionCodes(action)) if (this._down.has(c)) return true;
    return false;
  }

  pressed(action, force = false) {
    if (this.blocked && !force) return false;
    if (this._vPressed.has(action)) return true;
    for (const c of this._actionCodes(action)) if (this._pressed.has(c)) return true;
    return false;
  }

  released(action, force = false) {
    if (this.blocked && !force) return false;
    if (this._vReleased.has(action)) return true;
    for (const c of this._actionCodes(action)) if (this._released.has(c)) return true;
    return false;
  }

  /** Movement intent. x: right(+)/left(-), y: forward(+)/back(-). */
  moveAxis() {
    if (this.blocked) return { x: 0, y: 0 };
    let x = this._vAxis.x, y = this._vAxis.y;
    if (this.down('right')) x += 1;
    if (this.down('left')) x -= 1;
    if (this.down('forward')) y += 1;
    if (this.down('back')) y -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  /** Pixel look delta this frame, already scaled by settings (sensitivity, invertY). Returns radians-ready numbers. */
  lookRadians() {
    if (this.blocked) return { yaw: 0, pitch: 0 };
    const s = 0.0022 * (this.game.settings.mouseSensitivity || 1);
    const inv = this.game.settings.invertY ? -1 : 1;
    // Turning right decreases yaw; moving mouse down (dy>0) looks down (pitch decreases).
    return { yaw: -this.look.dx * s, pitch: -this.look.dy * s * inv };
  }

  // ---- virtual / touch API (ui/touch.js) ----
  setVirtual(action, isDown) {
    const was = !!this._virtual.get(action);
    if (isDown && !was) this._vPressed.add(action);
    if (!isDown && was) this._vReleased.add(action);
    this._virtual.set(action, !!isDown);
  }
  /** Virtual joystick. x right(+), y forward(+), each in [-1,1]. */
  setVirtualAxis(x, y) { this._vAxis.x = x; this._vAxis.y = y; }
  addLook(dx, dy) { this.look.dx += dx; this.look.dy += dy; }

  clear() {
    for (const c of this._down) this._released.add(c);
    this._down.clear();
    this._virtual.clear();
    this._vAxis.x = this._vAxis.y = 0;
  }

  /** Called by the game loop after all systems updated. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this._vPressed.clear();
    this._vReleased.clear();
    this.look.dx = this.look.dy = 0;
    this.wheel = 0;
  }
}
