// Gamepad-first input with keyboard/mouse fallback, exposed as named ACTIONS with press buffering.
//
// Gameplay reads (inside fixedUpdate):
//   input.move            {x, y}  left stick / WASD. x = right(+), y = forward/up(+). Radial deadzone applied, length <= 1
//   input.look            {x, y}  right stick (+ virtual look): a per-second RATE, -1..1. No mouse in it.
//   input.lookDelta       {x, y}  mouse look this frame as an ANGLE delta in 60 Hz stick-seconds (multiply by the same
//                                 rad/s factor as look, but NOT by dt), so mouse sensitivity does not depend on frame rate
//   input.down('guard')   held
//   input.pressed('light')       went down during the most recent frame (edge)
//   input.consume('light', 0.15) true if 'light' was pressed within the last 0.15 s of SIM time and not yet consumed.
//                                Use this for combat inputs so presses during hitstop / recovery are buffered.
//   input.stanceFlick()   'FR'|'FL'|'BR'|'BL'|null : stance chosen this frame (stance button held + right-stick quadrant, or 1-4 keys)
//                         A stick already deflected when the stance button goes down is not a flick: only a new quadrant
//                         (from centre or another quadrant) after the press is.
//   input.padType         'xbox' | 'ps' | 'generic' | null (null = keyboard/mouse is the last used device)
//   input.gamepadBlocked  true when the embedding page forbids the Gamepad API (events 'gamepad' {blocked} + 'gamepadBlocked')
//   input.rumble(strong, weak, ms)
// While game.uiOpen, gameplay queries return neutral values; UI code passes force=true.
//
// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping):
//   0 A/Cross  1 B/Circle  2 X/Square  3 Y/Triangle  4 LB/L1  5 RB/R1  6 LT/L2  7 RT/R2  8 Back/Share  9 Start/Options
//   10 LS click  11 RS click  12 up  13 down  14 left  15 right

export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/** Action -> gamepad buttons + keyboard codes ('Mouse0'/'Mouse2' for mouse buttons). Absolver-style layout. */
export const BINDINGS = {
  light:   { pad: [PAD.X], keys: ['Mouse0', 'KeyJ'] },          // main attack (string)
  heavy:   { pad: [PAD.Y], keys: ['Mouse2', 'KeyK'] },          // alternate attack
  guard:   { pad: [PAD.RB], keys: ['ShiftLeft', 'ShiftRight'] }, // hold to block; tap right after an attack starts = feint
  dodge:   { pad: [PAD.A], keys: ['Space'] },                   // dodge in the stick direction
  defend:  { pad: [PAD.B], keys: ['KeyE', 'KeyL'] },            // style ability: parry / absorb / avoid
  lock:    { pad: [PAD.LB], keys: ['Tab', 'KeyQ'] },            // lock-on toggle
  stance:  { pad: [PAD.RT], keys: ['KeyR'] },                   // hold + right stick (or WASD) = switch stance
  focus:   { pad: [PAD.LT], keys: ['KeyF'] },                   // focus attack (uses the focus meter)
  target:  { pad: [PAD.RS], keys: ['KeyT'] },                   // cycle locked target
  pause:   { pad: [PAD.START], keys: ['Escape', 'KeyP'] },
  deck:    { pad: [PAD.BACK], keys: ['KeyI'] },                 // combat deck (between fights)
  confirm: { pad: [PAD.A], keys: ['Enter', 'Space'] },          // UI
  back:    { pad: [PAD.B], keys: ['Escape', 'Backspace'] },     // UI
  up:      { pad: [PAD.UP], keys: ['ArrowUp', 'KeyW'] },        // UI navigation
  down:    { pad: [PAD.DOWN], keys: ['ArrowDown', 'KeyS'] },
  left:    { pad: [PAD.LEFT], keys: ['ArrowLeft', 'KeyA'] },
  right:   { pad: [PAD.RIGHT], keys: ['ArrowRight', 'KeyD'] },
  tabPrev: { pad: [PAD.LB], keys: ['KeyQ'] },
  tabNext: { pad: [PAD.RB], keys: ['KeyE'] },
};

const STICK_DEADZONE = 0.18;
const STANCE_KEYS = { Digit1: 'FL', Digit2: 'FR', Digit3: 'BL', Digit4: 'BR' };

function radial(x, y, dz) {
  const m = Math.hypot(x, y);
  if (m < dz) return { x: 0, y: 0 };
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return { x: x * k, y: y * k };
}

/** Quadrant of a stick vector: up = front, right = right. Needs a firm flick (|v| > 0.6). */
export function quadrantOf(x, y) {
  if (Math.hypot(x, y) < 0.6) return null;
  return (y >= 0 ? 'F' : 'B') + (x >= 0 ? 'R' : 'L');
}

export class Input {
  constructor(game) {
    this.game = game;
    this.canvas = game.renderer.domElement;
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.lookDelta = { x: 0, y: 0 };
    this.padType = null;
    this.padIndex = -1;
    this.padConnected = false;
    this.gamepadBlocked = false; // true when the embedding page forbids the Gamepad API
    this._keys = new Set();
    this._keyPressedFrame = new Set();
    this._padPrev = [];
    this._padNow = [];
    this._down = {};          // action -> bool (this frame)
    this._pressedFrame = {};  // action -> bool (edge this frame)
    this._buffer = {};        // action -> sim time of last press (not consumed)
    this._mouse = { dx: 0, dy: 0 };
    this._stanceFlick = null;
    this._stanceHeld = false; // stance button state last poll (down edge seeds _lastQuad)
    this._lastQuad = null;
    this._qStick = null;      // right-stick / move-stick (WASD) quadrants and how many polls each has held
    this._qStickAge = 0;
    this._qMove = null;
    this._qMoveAge = 0;
    this._virtual = {};       // action -> bool (tests / touch)
    this._vPrev = {};
    this._vMove = { x: 0, y: 0 };
    this._vLook = { x: 0, y: 0 };
    this._vStance = null;
    this.mouseSensitivity = 1;
    this.locked = false;
    this._bind();
  }

  _bind() {
    const isTyping = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this._keys.has(e.code)) this._keyPressedFrame.add(e.code);
      this._keys.add(e.code);
      this.padType = null;
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => { this._keys.clear(); });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousedown', (e) => {
      const c = 'Mouse' + e.button;
      if (!this._keys.has(c)) this._keyPressedFrame.add(c);
      this._keys.add(c);
      this.padType = null;
      if (!this.locked && this.game.state === 'playing' && !this.game.uiOpen && this.canvas.requestPointerLock) {
        try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* optional */ }
      }
    });
    window.addEventListener('mouseup', (e) => this._keys.delete('Mouse' + e.button));
    window.addEventListener('mousemove', (e) => {
      if (this.locked || e.target === this.canvas) { this._mouse.dx += e.movementX || 0; this._mouse.dy += e.movementY || 0; }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.game.events.emit('pointerLockChange', { locked: this.locked });
    });
    window.addEventListener('gamepadconnected', (e) => this.game.events.emit('gamepad', { connected: true, id: e.gamepad.id }));
    window.addEventListener('gamepaddisconnected', (e) => this.game.events.emit('gamepad', { connected: false, id: e.gamepad.id }));
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  /** navigator.getGamepads() can throw (SecurityError) inside iframes whose permissions policy blocks 'gamepad'. */
  _pads() {
    if (this.gamepadBlocked || !navigator.getGamepads) return [];
    try { return navigator.getGamepads() || []; }
    catch (e) {
      this.gamepadBlocked = true; // keyboard + mouse still work; UI can explain why the pad is ignored
      this.padType = null;        // no pad can be read: show keyboard glyphs
      this.game.events.emit('gamepad', { connected: false, blocked: true });
      this.game.events.emit('gamepadBlocked', { reason: (e && e.name) || 'SecurityError' });
      return [];
    }
  }

  _pollPad() {
    const pads = this._pads();
    let pad = null;
    for (const p of pads) { if (p && p.connected && p.mapping === 'standard') { pad = p; break; } }
    if (!pad) for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    this._padPrev = this._padNow;
    this._padNow = [];
    this.padConnected = !!pad;
    if (!pad) return null;
    this.padIndex = pad.index;
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i];
      this._padNow[i] = b.pressed || b.value > 0.5;
    }
    const any = this._padNow.some(Boolean) || pad.axes.some((a) => Math.abs(a) > 0.4);
    if (any) {
      const id = (pad.id || '').toLowerCase();
      // Xbox first: a Bluetooth Xbox pad reports 'Xbox Wireless Controller (... Vendor: 045e ...)'. Every Sony id carries
      // vendor 054c or a Sony product name, so the bare 'wireless controller' substring is not a PlayStation marker.
      this.padType = /xbox|045e|xinput/.test(id) ? 'xbox' : /054c|playstation|dualsense|dualshock/.test(id) ? 'ps' : 'generic';
    }
    return pad;
  }

  /** Called once per RENDER frame by the game loop, before simulation steps. */
  poll() {
    const pad = this._pollPad();
    const blocked = !!this.game.uiOpen;
    // movement
    let mx = 0, my = 0;
    if (this._keys.has('KeyD')) mx += 1;
    if (this._keys.has('KeyA')) mx -= 1;
    if (this._keys.has('KeyW')) my += 1;
    if (this._keys.has('KeyS')) my -= 1;
    mx += this._vMove.x; my += this._vMove.y;
    let lx = this._vLook.x, ly = this._vLook.y;
    if (pad) {
      const s = radial(pad.axes[0] || 0, -(pad.axes[1] || 0), STICK_DEADZONE);
      mx += s.x; my += s.y;
      const r = radial(pad.axes[2] || 0, -(pad.axes[3] || 0), STICK_DEADZONE);
      lx = r.x; ly = r.y;
    }
    const mm = Math.hypot(mx, my);
    if (mm > 1) { mx /= mm; my /= mm; }
    this.move.x = blocked ? 0 : mx; this.move.y = blocked ? 0 : my;
    // look: stick + virtual look as a rate; the mouse as a per-frame angle (60 Hz stick-seconds: the old 60 Hz feel)
    this.look.x = blocked ? 0 : lx;
    this.look.y = blocked ? 0 : ly;
    const ms = 0.06 * this.mouseSensitivity / 60;
    this.lookDelta.x = blocked ? 0 : this._mouse.dx * ms;
    this.lookDelta.y = blocked ? 0 : -this._mouse.dy * ms;
    this._mouse.dx = this._mouse.dy = 0;

    // actions
    const now = this.game.time;
    for (const [action, b] of Object.entries(BINDINGS)) {
      let d = false, p = false;
      for (const k of b.keys) { if (this._keys.has(k)) d = true; if (this._keyPressedFrame.has(k)) p = true; }
      for (const i of b.pad) { if (this._padNow[i]) d = true; if (this._padNow[i] && !this._padPrev[i]) p = true; }
      if (this._virtual[action]) { d = true; if (!this._vPrev[action]) p = true; }
      this._vPrev[action] = !!this._virtual[action];
      this._down[action] = d;
      this._pressedFrame[action] = p;
      if (p && !blocked) this._buffer[action] = now;
    }
    // stance flick: stance held + right stick quadrant (or WASD while R held), or number keys.
    // The source quadrant is tracked every poll; when the stance button goes down, a deflection that has already held
    // for 2+ polls (e.g. steering the camera) only seeds _lastQuad, so it is not a flick. A deflection that arrived
    // with the press (same or previous poll) still counts as a simultaneous chord.
    this._stanceFlick = null;
    const qStick = quadrantOf(lx, ly), qMove = quadrantOf(mx, my);
    if (qStick !== this._qStick) { this._qStick = qStick; this._qStickAge = 0; } else if (this._qStickAge < 1e6) this._qStickAge++;
    if (qMove !== this._qMove) { this._qMove = qMove; this._qMoveAge = 0; } else if (this._qMoveAge < 1e6) this._qMoveAge++;
    const q = qStick || (this._keys.has('KeyR') ? qMove : null);
    const qAge = qStick ? this._qStickAge : this._qMoveAge;
    const held = !!this._down.stance;
    if (!blocked) {
      for (const [code, st] of Object.entries(STANCE_KEYS)) if (this._keyPressedFrame.has(code)) this._stanceFlick = st;
      if (this._vStance) { this._stanceFlick = this._vStance; this._vStance = null; }
      if (held) {
        if (!this._stanceHeld) this._lastQuad = q && qAge >= 2 ? q : null;
        if (q && q !== this._lastQuad) this._stanceFlick = q;
        this._lastQuad = q;
      } else this._lastQuad = null;
    } else this._lastQuad = held ? q : null;   // never fire on the first unblocked poll
    this._stanceHeld = held;
    this._keyPressedFrame.clear();
  }

  down(action, force = false) { return (!this.game.uiOpen || force) && !!this._down[action]; }
  pressed(action, force = false) { return (!this.game.uiOpen || force) && !!this._pressedFrame[action]; }

  /** Buffered press: true (once) if `action` was pressed within `window` seconds of sim time. */
  consume(action, window = 0.15) {
    const t = this._buffer[action];
    if (t === undefined || this.game.uiOpen) return false;
    if (this.game.time - t > window) { delete this._buffer[action]; return false; }
    delete this._buffer[action];
    return true;
  }
  /** Peek at a buffered press without consuming it. */
  buffered(action, window = 0.15) {
    const t = this._buffer[action];
    return t !== undefined && this.game.time - t <= window && !this.game.uiOpen;
  }
  clearBuffer() { this._buffer = {}; }

  stanceFlick() { return this._stanceFlick; }

  // ---- virtual input (headless tests, touch overlays). Applied on the next poll().
  /** Hold (true) / release (false) an action as if its button were pressed. */
  setVirtual(action, isDown) { this._virtual[action] = !!isDown; }
  /** Virtual left stick (x right, y forward), each -1..1. */
  setVirtualMove(x, y) { this._vMove.x = x; this._vMove.y = y; }
  /** Virtual right stick. */
  setVirtualLook(x, y) { this._vLook.x = x; this._vLook.y = y; }
  /** Request a stance switch on the next poll (as if RT + right-stick flick). */
  virtualStance(stance) { this._vStance = stance; }

  /** Controller vibration (no-op without support). strong/weak 0..1, ms duration. */
  rumble(strong = 0.5, weak = 0.5, ms = 80) {
    if (this.game.settings && this.game.settings.rumble === false) return;
    const pads = this._pads();
    const pad = pads && this.padIndex >= 0 ? pads[this.padIndex] : null;
    const act = pad && pad.vibrationActuator;
    if (act && act.playEffect) {
      try { act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {}); } catch (e) { /* ignore */ }
    }
  }
}
