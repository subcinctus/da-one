// Training dummy brain (tests and the debug menu). Writes fighter.intent like an AI brain, but deterministic:
//   idle   stands and faces the player          block  holds guard
//   attack throws a string every `interval` s    parry  parries right before the player's hit lands (Forsaken)
//   avoid  ducks right before the hit (Windfall, set `avoidDir` for a side / jump avoid)
//   absorb absorbs right before the hit (Kahlt)
const DEFEND_LEAD = 0.07;   // seconds before the player's hit window opens

export class DummyBrain {
  constructor(combat, fighter, o = {}) {
    this.combat = combat;
    this.fighter = fighter;
    this.mode = o.mode || 'idle';
    this.interval = typeof o.interval === 'number' ? o.interval : 1.6;
    this.stringLen = typeof o.string === 'number' ? o.string : 1;
    this.kind = o.kind || 'light';
    this.avoidDir = o.avoidDir || null;   // {x, z} world stick for avoid mode, null = duck
    this.cool = typeof o.delay === 'number' ? o.delay : 0.8;
    this.left = 0;
    this._lastAtk = -1;
    this.defends = 0;
  }

  /** Write the intent for this step. */
  think(dt) {
    const f = this.fighter, it = f.intent, game = this.combat.game;
    const p = game.player;
    it.moveX = 0; it.moveZ = 0; it.guard = false; it.charge = false;
    it.lockTarget = p && p.alive ? p : null;
    if (!f.alive) return;
    const mode = this.mode;
    if (mode === 'block') { it.guard = true; return; }
    if (mode === 'attack') {
      this.cool -= dt;
      if (f.isFree() && this.cool <= 0) {
        it[this.kind === 'heavy' ? 'heavy' : 'light'] = true;
        this.left = this.stringLen - 1;
        this.cool = this.interval;
      } else if (this.left > 0 && f.state === 'attack' && f.attackPhase === 'active' && f.atk.startedAt !== this._chainKey) {
        this._chainKey = f.atk.startedAt;   // one follow-up press per move of the string
        it.light = true;
        this.left--;
      }
      return;
    }
    if (mode === 'parry' || mode === 'avoid' || mode === 'absorb') {
      if (this.avoidDir && mode === 'avoid') { it.moveX = this.avoidDir.x; it.moveZ = this.avoidDir.z; }
      if (!p || p.state !== 'attack' || !f.isFree()) return;
      const key = p.atk.startedAt;
      const tth = p.timeToHit();
      if (key !== this._lastAtk && tth >= 0 && tth <= DEFEND_LEAD + 1e-4) {
        this._lastAtk = key;
        it.defend = true;
        this.defends++;
      }
    }
  }
}
