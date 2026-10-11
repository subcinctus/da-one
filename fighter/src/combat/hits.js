// Hit resolution: strike-zone geometry (reach + target radius, arc), evasion by height / path (duck, jump, side
// avoid, attack properties during startup), dodge i-frames, parry / absorb / guard, and the consequences of a clean hit
// (damage with age + charge + counter, hitstun with combo scaling, stop, knockdown, push, focus, hit feel, events).
// Two passes per sim step (Combat.fixedUpdate): detectHits() on the stepped positions, then (after body collisions)
// resolveHits(), which animates each connecting attacker to this step first so impact points / FX come from the pose
// that connected, the pose hitstop holds on screen.
import * as THREE from 'three';
import { angleDiff, yawTo } from '../core/math.js';
import { strikePointWorld } from '../anim/rig.js';
import { T } from './constants.js';
import { activeWindow } from './movedata.js';
import { addLearn } from './learning.js';

const _p = new THREE.Vector3();
const SIM_DT = 1 / 120;
const PLAYER_RUMBLE = {
  dealt: { light: [0.1, 0.3, 45], medium: [0.25, 0.45, 70], heavy: [0.5, 0.6, 110] },
  taken: { light: [0.35, 0.5, 90], medium: [0.55, 0.6, 120], heavy: [0.85, 0.8, 170] },
};

/**
 * Pass 1, right after the fighters stepped (before body collisions): every active strike window touching an opponent
 * becomes a pending contact on combat._contacts (flat [attacker, defender, window, info] quads). Reach and arc are
 * judged on the stepped positions (FIGHTER.md §7 Hits). Returns the number of pending contacts.
 */
export function detectHits(combat) {
  const fs = combat.fighters;
  const c = combat._contacts || (combat._contacts = []);
  c.length = 0;
  for (let i = 0; i < fs.length; i++) {
    const a = fs[i];
    const atk = a.atk;
    if (a.state !== 'attack' || !a.alive || !atk.info || atk.phase !== 'run' || atk.charging) continue;
    const info = atk.info;
    const w = activeWindow(info, a.moveTime);
    if (w < 0) continue;
    if (atk.win !== w) { atk.win = w; atk.hitIds.length = 0; }
    for (let j = 0; j < fs.length; j++) {
      const d = fs[j];
      if (d === a || d.team === a.team || !d.alive || d.removed) continue;
      if (atk.hitIds.includes(d.id)) continue;
      if (!inStrikeZone(a, d, info)) continue;
      atk.hitIds.push(d.id);
      c.push(a, d, w, info);
    }
  }
  return c.length >> 2;
}

/**
 * Pass 2, after collisions and world bounds: resolve the pending contacts in order. Each attacker is first animated to
 * this sim step (Combat skips it in its own animation pass), so the impact point is read from the pose that connected,
 * the same pose the hitstop then holds on screen (Combat.update). Contacts of an attacker that an earlier contact this
 * step parried, stunned or killed, or on a defender already dead, are dropped (as the old single-pass loop did).
 * Called once per sim step by Combat, after detectHits().
 */
export function resolveHits(combat, dt = SIM_DT) {
  const c = combat._contacts;
  if (!c || !c.length) return;
  for (let k = 0; k < c.length; k += 4) {
    const a = c[k], d = c[k + 1], w = c[k + 2], info = c[k + 3];
    const atk = a.atk;
    if (a.state !== 'attack' || !a.alive || a.removed || atk.info !== info || atk.phase !== 'run') continue;
    if (!d.alive || d.removed) continue;
    poseNow(combat, a, dt);
    contact(combat, a, d, info, info.hits[w]);
  }
  c.length = 0;
}

/** Animate `f` to the current sim step now (once per step; Combat's animation pass then skips it). */
function poseNow(combat, f, dt) {
  const id = combat._stepId;
  if (typeof id !== 'number' || f._animStep === id || typeof f.animate !== 'function') return;
  f._animStep = id;
  f.animate(dt);
}

/** Reach + target radius, inside the arc of the attacker's facing (FIGHTER.md §7 Hits). */
export function inStrikeZone(a, d, info) {
  const dx = d.position.x - a.position.x, dz = d.position.z - a.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > info.reach + d.radius) return false;
  if (dist < a.radius + d.radius + 0.05) return true;     // point blank
  const ang = Math.abs(angleDiff(a.yaw, Math.atan2(dx, dz)));
  return ang <= info.arcHalf + Math.atan2(d.radius, dist);
}

/** Is the attacker in front of the defender (guard / parry only work facing the threat)? */
export function frontal(d, a) {
  return Math.abs(angleDiff(d.yaw, yawTo(d.position.x, d.position.z, a.position.x, a.position.z))) <= T.GUARD_ARC;
}

/** How `d` evades this strike right now, or null: 'duck' | 'jump' | 'left' | 'right'. */
export function evasion(a, d, info) {
  const h = info.height, p = info.path;
  if (d.avoiding) {
    const k = d.avoidKind;
    if (k === 'duck') return h === 'high' ? 'duck' : null;
    if (k === 'jump') return h === 'low' ? 'jump' : null;
    // side avoid: thrusts and verticals, and horizontals swung from the far side (a right-limb swing arrives on
    // the defender's left, so stepping right slips it and vice versa)
    if (p === 'thrust' || p === 'vertical') return k;
    const fromRight = /R$/.test(info.limb);
    return (fromRight && k === 'right') || (!fromRight && k === 'left') ? k : null;
  }
  // attack properties protect during their own startup (Absolver duck / jump / strafe)
  if (d.state === 'attack' && d.atk.info && d.atk.phase === 'run' && d.moveTime < d.atk.info.firstStart) {
    const pr = d.atk.info.props;
    if (pr.duck && h === 'high') return 'duck';
    if (pr.jump && h === 'low') return 'jump';
    if (pr.strafe && (p === 'thrust' || p === 'vertical')) return 'left';
  }
  return null;
}

function ageMult(game, f) {
  if (f.team !== 'player') return 1;
  const fl = game.flow;
  const m = fl && typeof fl.ageDamageMult === 'function' ? fl.ageDamageMult() : 1;
  return typeof m === 'number' && isFinite(m) && m > 0 ? m : 1;
}

/** World-space impact point (limb tip when it is close, else the defender's surface at the move's height). */
export function hitPoint(a, d, info, limb, out = new THREE.Vector3()) {
  const dx = d.position.x - a.position.x, dz = d.position.z - a.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const y = (T.HIT_POINT_Y[info.height] || 1.1) * (d.height / 1.8);
  out.set(d.position.x - (dx / len) * d.radius * 0.8, y, d.position.z - (dz / len) * d.radius * 0.8);
  if (a.model && a.model.skeleton) {
    try {
      simStrikePoint(a, limb || info.limb, _p);
      if (isFinite(_p.x) && _p.distanceTo(out) < 0.7) out.lerp(_p, 0.6);
    } catch (e) { /* model without that joint: keep the surface point */ }
  }
  return out;
}

const _rp = new THREE.Vector3();
/**
 * Strike point of `a` in its SIM pose (animator.out: this step's pose once resolveHits has posed the attacker) at its
 * SIM root transform. The skeleton and model.root otherwise hold the last displayed frame (render-interpolated, up to a
 * sim step short of contact), so the sim pose is applied and the root swapped for the sim transform while the point is
 * read; the root is then restored (Combat.update re-renders both before the next draw). Allocation-free.
 */
function simStrikePoint(a, name, out) {
  const m = a.model, sk = m.skeleton, root = m.root, an = a.animator;
  if (an && an.out && typeof an.out.applyTo === 'function') an.out.applyTo(sk);
  if (!root) return strikePointWorld(sk, name, out);
  _rp.copy(root.position);
  const ry = root.rotation.y;
  root.position.x = a.position.x; root.position.z = a.position.z;
  root.rotation.y = a.yaw;
  try { strikePointWorld(sk, name, out); }
  finally {
    root.position.copy(_rp);
    root.rotation.y = ry;
    root.updateMatrixWorld(true);
  }
  return out;
}

function involvesPlayer(game, a, d) { return game.player === a || game.player === d; }

/** Additive procedural flinch on the defender's animator (subtle body sway on top of the reaction clip). */
function flinch(d, dir, amount) {
  const an = d.animator;
  if (an && typeof an.flinchWorld === 'function') { try { an.flinchWorld(dir, amount); } catch (e) { /* optional */ } }
}
const FLINCH = { light: 0.35, medium: 0.6, heavy: 0.9 };

function feel(game, a, d, weight, stop, dir, extra = 0) {
  const g = game;
  if (stop > 0 && typeof g.hitstop === 'function') {
    g.hitstop(stop);
    // the attacker's strike form already stood still for this long: it counts toward the chain hold (§6b)
    const atk = a.atk;
    if (atk && a.state === 'attack' && !(g.settings && g.settings.hitPause === false)) atk.stopServed = Math.max(atk.stopServed || 0, stop);
  }
  if (!involvesPlayer(g, a, d)) return;
  const cam = g.cameraRig;
  const sh = (T.SHAKE[weight] || T.SHAKE.light) + extra;
  if (cam && typeof cam.shake === 'function') cam.shake(Math.min(1, sh));
  if (dir && weight !== 'light' && cam && typeof cam.punch === 'function') cam.punch(dir);
  const r = (g.player === a ? PLAYER_RUMBLE.dealt : PLAYER_RUMBLE.taken)[weight] || PLAYER_RUMBLE.dealt.light;
  if (g.input && typeof g.input.rumble === 'function') g.input.rumble(r[0], r[1], r[2]);
}

/** Resolve one strike window of `a` touching `d`. */
export function contact(combat, a, d, info, h) {
  const g = combat.game;
  const now = g.time;
  const props = info.props;
  const focus = a.atk.focus;
  const move = a.atk.move;
  const unblockable = !!focus || !!props.unblockable || !!(move && move.focus);
  const brk = !!props.break || a.atk.chargeBreak;

  // 1. invulnerable (dodge i-frames, getup, knockdown, grace)
  if (d.invulnerable) {
    if (d.state === 'dodge') g.events.emit('avoided', { attacker: a, defender: d, move, kind: 'dodge' });
    return;
  }
  // 2. avoid style / evasive attack properties
  const ev = evasion(a, d, info);
  if (ev) {
    if (d.state === 'avoid') {
      d.avoidSuccess = true;
      d.counterUntil = now + T.COUNTER_WINDOW;
      d.gainFocus(T.FOCUS_DEFEND);
      addLearn(g, d, move, T.LEARN_DEFEND);
      if (involvesPlayer(g, a, d) && g.input && typeof g.input.rumble === 'function' && g.player === d) g.input.rumble(0.05, 0.25, 40);
    }
    g.events.emit('avoided', { attacker: a, defender: d, move, kind: ev });
    return;
  }
  // 3. parry (Forsaken): no damage, the attacker staggers
  if (d.parrying && !unblockable && frontal(d, a)) {
    const point = hitPoint(a, d, info, h.limb);
    a.atk.anyContact = true;
    d._parrySuccess();
    d.gainFocus(T.FOCUS_DEFEND);
    a.enterStagger(T.PARRY_STAGGER, 'parried');
    g.events.emit('parried', { attacker: a, defender: d, move, point });
    addLearn(g, d, move, T.LEARN_DEFEND);
    feel(g, a, d, 'medium', T.HITSTOP_PARRY, null);
    return;
  }
  // 4. absorb (Kahlt): soak 60% without flinching; break moves pierce
  let pierced = false;
  if (d.state === 'absorb' && !unblockable) {
    if (brk) pierced = true;
    else {
      const dmg = damageOf(g, a, d, info, h, false) * (1 - T.ABSORB_REDUCTION);
      if (d.health - dmg > 0) {
        const point = hitPoint(a, d, info, h.limb);
        const taken = d.god ? 0 : dmg;
        d.health -= taken;
        d.absorbStored += taken;
        d.absorbHealUntil = now + T.ABSORB_HEAL_WINDOW;
        d.absorbHits++;
        d.gainFocus(T.FOCUS_ABSORB);
        a.atk.anyContact = true;
        g.events.emit('absorbed', { attacker: a, defender: d, move, point, pierced: false, damage: taken });
        flinch(d, dirFrom(a, d, _p), 0.45);
        addLearn(g, d, move, T.LEARN_DEFEND);
        feel(g, a, d, 'light', T.HITSTOP_ABSORB, null);
        return;
      }
    }
  }
  // 5. guard: -80% damage, stamina drain, blockstun; break / drained guard = guard broken; fails from behind
  if (!pierced && d.isGuarding() && !unblockable && frontal(d, a)) {
    const point = hitPoint(a, d, info, h.limb);
    const chip = d.god ? 0 : damageOf(g, a, d, info, h, false) * (1 - T.GUARD_REDUCTION);
    d.health = Math.max(1, d.health - chip);
    d._spend(info.guardDamage);
    const broken = brk || d.stamina <= 0;
    a.atk.anyContact = true;
    g.events.emit('blocked', { attacker: a, defender: d, move, point, guardBroken: broken, damage: chip });
    const dir = dirFrom(a, d, new THREE.Vector3());
    if (broken) d.enterGuardBroken();
    else d.enterBlockstun(info.blockstun);
    flinch(d, dir, broken ? 0.7 : 0.25);
    d.pushVel.addScaledVector(dir, info.push * 0.6 * T.PUSH_DECAY);
    d.gainFocus(T.FOCUS_BLOCK);
    addLearn(g, d, move, T.LEARN_BLOCK);
    feel(g, a, d, broken ? 'medium' : 'light', broken ? T.HITSTOP.medium : Math.max(T.HITSTOP_BLOCK, 0.6 * info.hitstop), broken ? dir : null);
    return;
  }
  if (pierced) {
    g.events.emit('absorbed', { attacker: a, defender: d, move, point: hitPoint(a, d, info, h.limb), pierced: true, damage: 0 });
  }
  cleanHit(combat, a, d, info, h);
}

function dirFrom(a, d, out) {
  const dx = d.position.x - a.position.x, dz = d.position.z - a.position.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return out.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
  return out.set(dx / len, 0, dz / len);
}

function isCounter(g, a, d) {
  return g.time < a.counterUntil || d.state === 'stagger' || d.state === 'guardbroken' ||
    (d.state === 'attack' && d.attackPhase === 'startup');
}

/** Raw damage of a window from a to d (charge, counter, age, fighter multiplier). */
function damageOf(g, a, d, info, h, counter) {
  let dmg = h.damage * a.atk.chargeMult * a.damageMult * ageMult(g, a);
  if (counter) dmg *= T.COUNTER_MULT;
  return Math.round(dmg * 10) / 10;
}

function cleanHit(combat, a, d, info, h) {
  const g = combat.game;
  const props = info.props;
  const focus = a.atk.focus;
  const brk = !!props.break || a.atk.chargeBreak;
  const counter = isCounter(g, a, d);
  let dmg = damageOf(g, a, d, info, h, counter);
  if (d.god) dmg = 0;
  // committed heavy attacks shrug off light non-stop jabs late in their wind-up (gives `stop` its meaning)
  const da = d.atk;
  const armored = !focus && d.state === 'attack' && da.info && da.info.weight === 'heavy' && info.weight === 'light' &&
    !props.stop && !brk && !props.knockdown && (da.charging || (da.phase === 'run' && d.moveTime < da.info.firstStart && d.moveTime >= da.info.firstStart * T.ARMOR_FROM));
  d.health = Math.max(0, d.health - dmg);
  const killed = d.health <= 0;
  const dir = dirFrom(a, d, new THREE.Vector3());
  const point = hitPoint(a, d, info, h.limb);
  a.atk.anyContact = true;
  if (!focus) a.gainFocus(T.FOCUS_HIT);
  // Kahlt payoff: landing a hit soon after absorbing heals the absorbed damage back
  if (a.absorbStored > 0 && g.time < a.absorbHealUntil) {
    const healed = a.absorbStored;
    a.heal(healed);
    a.absorbStored = 0;
    a.absorbHealUntil = -1e9;
    g.events.emit('absorbHeal', { fighter: a, amount: healed });
  }
  const weight = focus ? 'heavy' : info.weight;
  g.events.emit('hit', {
    attacker: a, defender: d, move: a.atk.move, damage: dmg, point, dir, heavy: weight === 'heavy', counter, killed,
    weight, height: info.height, limb: h.limb, armored, focus: focus || null, string: a.atk.string, charge: a.atk.chargeMult - 1,
  });
  if (killed) {
    d.pushVel.addScaledVector(dir, Math.max(info.push, 0.7) * T.PUSH_DECAY);
    d._die(a);
    if (d.team !== 'player' && combat.enemiesAlive() === 0) g.slowmo?.(0.3, 0.7);
    else if (d === g.player) g.slowmo?.(0.35, 0.9);
    feel(g, a, d, 'heavy', T.HITSTOP_KILL, dir, 0.1);
    return;
  }
  if (!armored) {
    if (focus === 'sweep' || props.knockdown) {
      d.enterKnockdown();
    } else if (focus === 'strike') {
      d.enterHitstun(T.FOCUS_STRIKE_STUN, 'hit_heavy');
    } else if (d.stamina <= 0) {
      // out of stamina: a long, punishing stagger
      d.enterStagger(Math.max(T.STAGGER_EXHAUSTED, info.hitstun), 'hit_heavy');
    } else {
      const stunned = d.state === 'hitstun' || d.state === 'stagger';
      const scale = stunned ? Math.max(T.COMBO_SCALE_MIN, 1 - T.COMBO_SCALE_STEP * (d.comboCount + 1)) : 1;
      const stun = info.hitstun * (props.stop ? T.STOP_STUN_MULT : 1) * scale;
      d.enterHitstun(stun, info.weight === 'heavy' ? 'hit_heavy' : 'hit_' + info.height);
    }
    d.pushVel.addScaledVector(dir, info.push * T.PUSH_DECAY);
  }
  flinch(d, dir, armored ? 0.3 : FLINCH[weight] || 0.4);
  feel(g, a, d, weight, focus ? T.HITSTOP_FOCUS : info.hitstop, dir);
}
