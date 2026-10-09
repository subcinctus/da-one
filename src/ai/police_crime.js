// Crime ledger (POLICE agent): turns game events into wanted stars, following the contract table (§Police):
//   assault on a civilian  +1 if a cop within 40 m with line of sight witnesses it, else +1 on the 2nd offence
//   murder +1 (always)      killing a cop +2       carjack +1        stealing a police vehicle +2
//   explosion +1            gunfire within 50 m of a cop +1        hit-and-run +1
// plus a few GTA-style extras: attacking an officer / police car (1 star, escalating), unwitnessed gunfire reported
// by nearby civilians (counts as a minor offence), witnessed car theft / vandalism.
// Every victim is counted once per kind (the same hit can arrive as entityDamaged + a 'crime' event), and Police
// caps how many stars one incident can add (a single TNT blast is not an instant 5 stars).
import { TUNE } from './police_const.js';

const isCopEntity = (e) => !!e && (e.kind === 'cop' || (e.team === 'police' && e.kind !== 'vehicle' && e.kind !== 'heli'));
const isPoliceVehicle = (e) => !!e && (e.kind === 'vehicle' || e.kind === 'heli') && (e.isPolice || e.team === 'police');
const isPerson = (e) => !!e && (e.kind === 'ped' || e.team === 'civilian' || e.team === 'gang') && e.kind !== 'vehicle' && e.kind !== 'heli';

export class CrimeLedger {
  constructor(police) {
    this.police = police;
    this.game = police.game;
    this.victims = new WeakMap();
    this.offences = 0;
    this.offenceT = -1e9;
    this.cool = new Map();
    this.lastKillT = -1e9;
    this.lastCopKillT = -1e9;
    this.carjackT = -1e9;
    this.policeTheftT = -1e9;
    this.theftT = -1e9;
    /** Recent crimes for debugging / tests: [{t, type, points}] */
    this.log = [];
  }

  get now() { return this.game.time || 0; }

  _cool(key, seconds) {
    const t = this.now, until = this.cool.get(key);
    if (until !== undefined && until > t) return false;
    this.cool.set(key, t + seconds);
    return true;
  }

  _rec(e) {
    let r = this.victims.get(e);
    if (!r) { r = { given: 0, t: -1e9, killed: false, offence: false }; this.victims.set(e, r); }
    return r;
  }

  _add(points, reason, pos) {
    this.log.push({ t: +this.now.toFixed(2), type: reason, points });
    if (this.log.length > 40) this.log.shift();
    return this.police.addHeat(points, reason, pos);
  }

  /** Two unwitnessed minor offences (assault, gunfire reported by civilians) -> +1 star. */
  minorOffence(pos, reason) {
    const t = this.now;
    if (t - this.offenceT > TUNE.OFFENCE_MEMORY) this.offences = 0;
    this.offences++;
    this.offenceT = t;
    this.log.push({ t: +t.toFixed(2), type: 'offence:' + reason, points: 0 });
    if (this.offences >= 2) {
      this.offences = 0;
      this._add(1, reason, pos);
    }
  }

  // ============================================================================================ event handlers

  onDamaged(ev) {
    const g = this.game, P = this.police;
    if (!ev || !ev.entity || !ev.info || ev.info.source !== g.player || !g.player) return;
    const e = ev.entity;
    if (e === g.player) return;
    const fatal = !(e.health > 0) || e.alive === false;
    if (isCopEntity(e)) { this.copAssault(e, ev.amount, ev.info); return; }
    if (isPoliceVehicle(e)) {
      // collisions: during a chase the cops ram you (not a crime); at 0 stars only a real crash into a cruiser counts
      if (ev.info.type === 'vehicle' && (P.wanted > 0 || ev.amount < 25)) return;
      this.copAssault(e, ev.amount, ev.info);
      return;
    }
    if (isPerson(e) && !fatal) this.assault(e, e.position);
  }

  onKilled(ev) {
    const g = this.game, P = this.police;
    if (!ev || !ev.entity || !ev.info || ev.info.source !== g.player || !g.player) return;
    const e = ev.entity;
    if (e === g.player) return;
    const r = this._rec(e);
    if (r.killed) return;
    r.killed = true;
    if (isCopEntity(e)) {
      this.lastCopKillT = this.now;
      this._add(2, 'Killing an officer', e.position);
      P.reveal();
      return;
    }
    if (isPoliceVehicle(e)) {
      const crew = e.policeCrewLost || 0;
      this._add(crew > 0 ? 2 : 1, 'Destroying a police vehicle', e.position);
      P.reveal();
      return;
    }
    if (isPerson(e)) {
      this.lastKillT = this.now;
      this._add(1, 'Murder', e.position);
    }
  }

  onCrime(ev) {
    if (!ev || !ev.type) return;
    const g = this.game, P = this.police;
    const pos = ev.position || (g.player && g.player.position);
    const victim = ev.victim && typeof ev.victim === 'object' ? ev.victim : null;
    switch (ev.type) {
      case 'murder':
        if (victim) { const r = this._rec(victim); if (r.killed) return; r.killed = true; }
        else if (this.now - this.lastKillT < 0.5) return;
        this.lastKillT = this.now;
        this._add(1, 'Murder', pos);
        break;
      case 'copMurder':
        if (victim) { const r = this._rec(victim); if (r.killed) return; r.killed = true; }
        else if (this.now - this.lastCopKillT < 0.5) return;
        this.lastCopKillT = this.now;
        this._add(2, 'Killing an officer', pos);
        P.reveal();
        break;
      case 'assault':
        if (victim) this.assault(victim, pos);
        else if (this._cool('assaultEvt', 3)) {
          if (P.copWitness(pos)) this._add(1, 'Assault', pos); else this.minorOffence(pos, 'Assault');
        }
        break;
      case 'copAssault':
        this.copAssault(victim, 10, null);
        break;
      case 'carjack':
        if (!this._cool('carjack', 1.0)) return;
        this.carjackT = this.now;
        this._add(1, 'Carjacking', pos);
        break;
      case 'vehicleTheft':
        if (ev.police) {
          if (!this._cool('policeTheft', 2)) return;
          this.policeTheftT = this.now;
          this._add(2, 'Stealing a police vehicle', pos);
        } else {
          this.theftT = this.now;
          if (P.copWitness(pos) && this._cool('theft', 5)) this._add(1, 'Grand theft auto', pos);
        }
        break;
      case 'explosion':
        this.explosion(pos);
        break;
      case 'gunfire':
        this.gunfire(pos);
        break;
      case 'hitAndRun':
        this.hitAndRun(victim, pos);
        break;
      case 'vandalism':
        if (P.copWitness(pos) && this._cool('vandalism', 10)) this._add(1, 'Vandalism', pos);
        break;
      default: {
        // unknown crime types: count when witnessed, scaled by severity
        const sev = Math.max(1, Math.min(2, Number(ev.severity) || 1));
        if (P.copWitness(pos) && this._cool('misc:' + ev.type, 4)) this._add(sev, ev.type, pos);
      }
    }
  }

  onGunfire(ev) {
    const g = this.game;
    if (!ev || !g.player || ev.shooter !== g.player) return;
    this.gunfire(ev.position || g.player.position);
  }

  onExplosion(ev) {
    const g = this.game;
    if (!ev || !g.player || ev.source !== g.player) return;
    this.explosion(ev.position);
  }

  onVehicleEnter(ev) {
    const g = this.game, P = this.police;
    if (!ev || !ev.vehicle || (ev.character && ev.character !== g.player)) return;
    const v = ev.vehicle, t = this.now;
    if (!ev.stolen) return;
    if (v.isPolice) {
      if (t - this.policeTheftT > 1 && this._cool('policeTheft', 2)) {
        this.policeTheftT = t;
        this._add(2, 'Stealing a police vehicle', v.position);
      }
      return;
    }
    if (t - this.carjackT > 1 && t - this.theftT > 1 && P.copWitness(v.position) && this._cool('theft', 5)) {
      this._add(1, 'Grand theft auto', v.position);
    }
  }

  // ============================================================================================ rules

  assault(e, pos) {
    const P = this.police;
    const r = this._rec(e);
    const t = this.now;
    if (r.given >= 1 && t - r.t < 15) return;
    r.t = t;
    if (P.copWitness(pos || e.position)) {
      r.given = 1;
      this._add(1, 'Assault', pos);
    } else if (!r.offence) {
      r.offence = true;
      this.minorOffence(pos, 'Assault');
    }
  }

  copAssault(e, amount, info) {
    const P = this.police;
    P.onCopAttacked(e, info);
    if (P.wanted < 2) {
      if (this._cool('copAssault', 4)) this._add(1, 'Assaulting an officer', e ? e.position : null);
    } else if (this._cool('copAssaultHeat', 1.5)) {
      this._add(0.25, 'Assaulting an officer', e ? e.position : null);
    }
  }

  hitAndRun(victim, pos) {
    if (victim && isCopEntity(victim)) return; // handled as an attack on an officer
    if (victim) {
      const r = this._rec(victim);
      const t = this.now;
      if ((r.given >= 1 && t - r.t < 15) || r.killed) return;
      r.given = 1; r.t = t;
    } else if (!this._cool('hitAndRun', 2)) return;
    this._add(1, 'Hit and run', pos);
  }

  explosion(pos) {
    const g = this.game, P = this.police;
    if (!pos) return;
    if (!this._cool('explosion', 3)) return;
    const plan = g.generator && g.generator.plan;
    const inCity = !!(plan && typeof plan.isCity === 'function' && plan.isCity(pos.x, pos.z));
    // remote quarry blasting with nobody around is not a crime anyone reports
    if (inCity || P.copNear(pos, 60) || P.civiliansNear(pos, 60)) this._add(1, 'Explosion', pos);
    else this.cool.delete('explosion');
  }

  gunfire(pos) {
    const P = this.police;
    if (!pos) return;
    if (P.copNear(pos, TUNE.GUNFIRE_RANGE)) {
      // shooting near the police always gives your position away
      if (P.wanted > 0) P.reveal();
      if (P.wanted === 0 && this._cool('gunCop', 6)) this._add(1, 'Shots fired near police', pos);
    } else if (P.civiliansNear(pos, TUNE.CIVIL_REPORT_RANGE) && this._cool('gunCivil', 6)) {
      this.minorOffence(pos, 'Shots fired');
    }
  }
}
