// Crowd director (Sifu): at most `maxAttackers` (2) enemies hold an attack token at once; everybody else circles on
// a ring 3-5 m around the player, spread out in front of the player's view so nobody attacks from off-screen while
// they wait. Tokens rotate (strings thrown, waiting time, who the player is fighting), openers from different
// enemies are spaced so two strikes never start on the same beat, and circle slots avoid walls.
// Runs a cheap assignment every TICK seconds; no allocations (scratch arrays are reused).
import { angleDiff } from '../core/math.js';

const TICK = 0.12;
const OPEN_GAP = 0.38;         // min seconds between openers of two different enemies
const SLOT_SPACING = 0.72;     // ~41 deg between circlers
const SLOT_SPAN = 2.0;         // circlers stay within ~±115 deg of the player's facing
const MAX_ENGAGE = 4.5;        // a token held this long without attacking goes back to the pool
const MAX_HOLD = 5.0;          // nobody keeps a token longer than this while others wait (between strings)

export class Director {
  constructor(ai) {
    this.ai = ai;
    this.maxAttackers = 2;
    this._t = 0;
    this._circ = [];
    this._cand = [];
    this._hold = [];
    this.attackingNow = 0;
    this.peakAttacking = 0;
    this.peakTokens = 0;
    this.lastOpenAt = -1e9;
    this.lastOpener = null;
  }

  /** Reset the per-fight counters (new room). */
  resetStats() { this.peakAttacking = 0; this.peakTokens = 0; }

  /** Number of brains currently holding a token. */
  tokenCount() {
    let n = 0;
    const bs = this.ai.brains;
    for (let i = 0; i < bs.length; i++) if (bs[i].hasToken) n++;
    return n;
  }

  update(dt, now, player) {
    const bs = this.ai.brains;
    // live bookkeeping (cheap): how many enemies are mid-attack right now
    let atk = 0;
    for (let i = 0; i < bs.length; i++) { const f = bs[i].fighter; if (f.alive && f.state === 'attack') atk++; }
    this.attackingNow = atk;
    if (atk > this.peakAttacking) this.peakAttacking = atk;
    this._t -= dt;
    if (this._t > 0) return;
    this._t = TICK;
    this._assign(now, player);
  }

  /** May `brain` start an opener now (spacing between different attackers)? */
  canOpen(brain, now) { return this.lastOpener === brain || now - this.lastOpenAt >= OPEN_GAP; }
  noteOpen(brain, now) { this.lastOpenAt = now; this.lastOpener = brain; }

  /**
   * Ask for a token outside the regular tick (counters / punishes). Urgent requests may take the token from a holder
   * that is not mid-attack. Returns true when the brain holds a token afterwards.
   */
  tryGrant(brain, urgent, now) {
    if (brain.hasToken) return true;
    if (!this.ai.target(brain.fighter)) return false;
    if (this.tokenCount() < this.maxAttackers) { brain.grantToken(now); this._peak(); return true; }
    if (!urgent) return false;
    const bs = this.ai.brains;
    let victim = null, worst = Infinity;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b.hasToken || b.bossId || b.mode === 'attack' || b.mode === 'windup') continue;
      const s = -b.dist;
      if (s < worst) { worst = s; victim = b; }
    }
    if (!victim) return false;
    victim.revokeToken(now, 0.8);
    brain.grantToken(now);
    return true;
  }

  /** Hand a token back (string budget spent, out of stamina, gave up). */
  release(brain, now, rest) { if (brain.hasToken) brain.revokeToken(now, rest); }

  _peak() { const n = this.tokenCount(); if (n > this.peakTokens) this.peakTokens = n; }

  _assign(now, player) {
    const ai = this.ai, bs = ai.brains;
    const cand = this._cand, circ = this._circ, hold = this._hold;
    cand.length = 0; circ.length = 0; hold.length = 0;
    const alive = player && player.alive && !player.removed;
    let holders = 0;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i], f = b.fighter;
      const active = f.alive && !b.dormant && alive;
      if (!active) { if (b.hasToken) b.revokeToken(now, 0.5); continue; }
      // stale tokens: engaged for ages without throwing anything
      if (b.hasToken && !b.bossId && b.mode === 'engage' && now - b.tokenAt > MAX_ENGAGE && now - b.pressedAt > MAX_ENGAGE) {
        b.revokeToken(now);
      }
      if (b.hasToken) holders++;
      else {
        circ.push(b);
        if (now >= b.tokenRestUntil && b.mode !== 'retreat' && b.mode !== 'taunt' && b.mode !== 'phase'
          && f.stamina >= b.profile.staminaResume * 0.7) cand.push(b);
      }
    }
    if (!alive) return;
    // rotation: a long-time holder steps back between strings when someone is waiting
    if (cand.length) {
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (!b.hasToken || b.bossId || b.mode === 'attack' || b.mode === 'windup' || now - b.tokenAt < MAX_HOLD) continue;
        b.revokeToken(now);
        holders--;
        break;
      }
    }
    // bosses always fight
    for (let i = 0; i < cand.length; i++) if (cand[i].bossId) { cand[i].grantToken(now); holders++; }
    // grant free tokens to the best candidates
    let free = this.maxAttackers - holders;
    while (free > 0) {
      let best = null, bs2 = -Infinity;
      for (let i = 0; i < cand.length; i++) {
        const b = cand[i];
        if (b.hasToken) continue;
        const s = this._score(b, now, player);
        if (s > bs2) { bs2 = s; best = b; }
      }
      if (!best) break;
      best.grantToken(now);
      free--;
    }
    this._peak();
    for (let i = 0; i < bs.length; i++) { const b = bs[i]; if (b.hasToken && b.fighter.alive && !b.dormant) hold.push(b); }
    this._flank(player);
    this._slots(now, player);
  }

  /** Attackers come in from different sides (~70 deg apart), both inside the player's view. */
  _flank(player) {
    const hold = this._hold, n = hold.length;
    if (!n) return;
    const px = player.position.x, pz = player.position.z, front = player.yaw;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const f = hold[i].fighter;
      hold[i]._rel = angleDiff(front, Math.atan2(f.position.x - px, f.position.z - pz));
      mean += hold[i]._rel;
    }
    mean /= n;
    if (n === 1) { const r = hold[0]._rel; hold[0].slotAngle = front + Math.max(-1.1, Math.min(1.1, r)); return; }
    if (hold[0]._rel > hold[1]._rel) { const t = hold[0]; hold[0] = hold[1]; hold[1] = t; }
    const c = Math.max(-0.7, Math.min(0.7, mean));
    for (let i = 0; i < n; i++) hold[i].slotAngle = front + c + (i - (n - 1) / 2) * 1.2;
  }

  /** Token priority: close, keen, waited long, in the player's view, the one the player is fighting. */
  _score(b, now, player) {
    const f = b.fighter;
    const dx = f.position.x - player.position.x, dz = f.position.z - player.position.z;
    const ang = Math.abs(angleDiff(player.yaw, Math.atan2(dx, dz)));
    let s = -b.dist * 0.6 + b.profile.aggression * 2 + Math.min(4, (now - b.lastTokenEnd) * 0.35);
    if (ang < 1.2) s += 1.6;                         // visible: in front of the player
    if (player.target === f) s += 3;                 // the one the player is locked on
    if (now - b.lastHitAt < 2) s += 1.5;             // just got hit: it wants back in
    return s;
  }

  /** Spread the circlers on the ring in front of the player; avoid unwalkable slots. */
  _slots(now, player) {
    const circ = this._circ;
    const n = circ.length;
    if (!n) return;
    const px = player.position.x, pz = player.position.z;
    const front = player.yaw;
    // current bearing of each circler relative to the player's facing
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const f = circ[i].fighter;
      circ[i]._rel = angleDiff(front, Math.atan2(f.position.x - px, f.position.z - pz));
      mean += circ[i]._rel;
    }
    mean /= n;
    // insertion sort by bearing (no allocation, n is tiny)
    for (let i = 1; i < n; i++) {
      const b = circ[i];
      let j = i - 1;
      while (j >= 0 && circ[j]._rel > b._rel) { circ[j + 1] = circ[j]; j--; }
      circ[j + 1] = b;
    }
    const half = ((n - 1) * SLOT_SPACING) / 2;
    const center = Math.max(-SLOT_SPAN + half, Math.min(SLOT_SPAN - half, mean * 0.6)) + Math.sin(now * 0.23) * 0.25;
    const world = this.ai.game.world;
    const walk = world && typeof world.isWalkable === 'function' ? world : null;
    for (let i = 0; i < n; i++) {
      const b = circ[i];
      let rel = center - half + i * SLOT_SPACING;
      if (rel > SLOT_SPAN) rel = SLOT_SPAN; else if (rel < -SLOT_SPAN) rel = -SLOT_SPAN;
      const ring = b.profile.ring;
      let R = ring[0] + (ring[1] - ring[0]) * b.ringPick;
      let a = front + rel;
      if (walk) {
        // try the slot, then nudge around it and inward until it is on the floor
        let ok = false;
        for (let k = 0; k < 7 && !ok; k++) {
          const da = k === 0 ? 0 : (k & 1 ? 1 : -1) * Math.ceil(k / 2) * 0.4;
          const rr = k >= 5 ? R - 1.0 : R;
          const x = px + Math.sin(front + rel + da) * rr, z = pz + Math.cos(front + rel + da) * rr;
          let w = true;
          try { w = walk.isWalkable(x, z, 0.5); } catch (e) { w = true; }
          if (w) { ok = true; a = front + rel + da; R = rr; }
        }
        if (!ok) R = Math.max(2.4, R - 1.4);
      }
      b.slotAngle = a;
      b.slotRadius = R;
    }
  }
}
