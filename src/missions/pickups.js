// Pickups (ARCHITECTURE.md §Pickups): floating / spinning / bobbing voxel pickups with a glow. Walk within 1.4 m
// (drive through for cash and mission packages) to collect: money, health, armor, weapons, ammo, blocks.
//
//   pickups.spawn(type, position, amount, { respawn: seconds|0, persistent, onCollect, mission, label })
//     type: 'cash' | 'health' | 'armor' | 'weapon:<id>' | 'ammo:<id>' | 'block:<id|KEY>' | 'package'
//   A spawn with neither `respawn` nor `persistent` is a DROP: it despawns after 30 s (blinking for the last 5 s).
//   World pickups (hospital health, police armor, hidden weapons...) respawn after 120 s, the mine's TNT crates after
//   600 s. Hidden cash bundles are one-time finds: serialize() lists the collected ones so a reload keeps them gone.
import * as THREE from 'three';
import { WEAPONS } from '../data/weapons.js';
import { BLOCKS, B } from '../world/blocks.js';
import { buildPickupModel, PICKUP_COLORS } from './pickup_models.js';
import { glowSprite, groundHalo } from './markers.js';
import { worldPickupSpecs } from './pickup_spots.js';
import { planOf, safe, notify, sound, fmtMoney, groundNear, HAS_DOM } from './util.js';

const DROP_LIFE = 30;
const COLLECT_R = 1.4;
const VIEW_R = 95;
const BLIP_R = 140;
const FLOAT_Y = 0.66;
const MODEL_SCALE = 1.2;   // pickups read better a touch larger than life

const _v = new THREE.Vector3();

/** Radar / map blip styles of world pickups (also drawn in the map legend). */
export const PICKUP_BLIPS = {
  weapon: { shape: 'dot', color: '#ffd23f', size: 3.5 },
  health: { shape: 'dot', color: '#ff7b7b', size: 3.5 },
  armor: { shape: 'dot', color: '#8fd8ff', size: 3.5 },
};

/** Parse a pickup type string -> {kind, sub}. Unknown -> null. */
export function parsePickupType(type) {
  const s = String(type || '');
  const i = s.indexOf(':');
  const kind = i >= 0 ? s.slice(0, i) : s;
  let sub = i >= 0 ? s.slice(i + 1) : null;
  if (kind === 'cash' || kind === 'health' || kind === 'armor' || kind === 'package') return { kind, sub: null };
  if (kind === 'weapon' || kind === 'ammo') return WEAPONS[sub] ? { kind, sub } : null;
  if (kind === 'block') {
    let id = Number.isFinite(Number(sub)) && sub !== '' ? Number(sub) : B[String(sub).toUpperCase()];
    if (!Number.isInteger(id) || !BLOCKS[id] || id === 0) return null;
    return { kind, sub: id };
  }
  return null;
}

/** Default amount per kind. */
function defaultAmount(kind, sub) {
  switch (kind) {
    case 'cash': return 100;
    case 'health': return 100;
    case 'armor': return 50;
    case 'weapon': { const w = WEAPONS[sub]; return w && w.mag ? w.mag * 3 : 0; }
    case 'ammo': { const w = WEAPONS[sub]; return w && w.mag ? Math.max(2, w.mag * 2) : 10; }
    case 'block': return 16;
    default: return 1;
  }
}

export class Pickups {
  constructor(game) {
    this.game = game;
    /** All pickups (active or waiting to respawn). */
    this.list = [];
    this._id = 1;
    this.root = null;
    this._settleBudget = 2;
    this._promptT = 0;
    this.stats = { collected: 0, spawned: 0 };
    /** Keys of collected one-time world pickups (hidden cash bundles); saved by SaveSystem. */
    this.collectedOnce = new Set();
  }

  init() {
    const g = this.game;
    this.root = new THREE.Group();
    this.root.name = 'pickups';
    if (g.scene) g.scene.add(this.root);
    try { this._scatterWorld(); } catch (e) { console.warn('[pickups] world scatter failed', e); }
    this._installDebug();
  }

  // ================================================================================================ public API

  /**
   * Spawn a pickup. position: {x,y,z} (y = ground / drop height; the model floats above it).
   * opts: {respawn: seconds (0 = none), persistent: never despawns, onCollect(p) -> false to refuse, mission,
   *        label (notification name), vehicle (collectable while driving), silent}.
   */
  spawn(type, position, amount, opts = {}) {
    const parsed = parsePickupType(type);
    if (!parsed || !position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return null;
    opts = opts || {};
    const amt = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Math.round(Number(amount)) : defaultAmount(parsed.kind, parsed.sub);
    const respawn = Math.max(0, Number(opts.respawn) || 0);
    const persistent = !!opts.persistent;
    const p = {
      id: this._id++,
      type: String(type),
      kind: parsed.kind,
      sub: parsed.sub,
      amount: amt,
      base: new THREE.Vector3(position.x, Number.isFinite(position.y) ? position.y : 28, position.z),
      respawn,
      persistent,
      drop: !respawn && !persistent,
      life: !respawn && !persistent ? DROP_LIFE : Infinity,
      mission: !!opts.mission,
      onCollect: typeof opts.onCollect === 'function' ? opts.onCollect : null,
      label: opts.label || null,
      vehicle: opts.vehicle !== undefined ? !!opts.vehicle : (parsed.kind === 'cash' || parsed.kind === 'package'),
      silent: !!opts.silent,
      active: true,
      settled: !!opts.settled,
      respawnT: 0,
      collectT: 0,
      popT: 0.35,
      phase: Math.random() * Math.PI * 2,
      obj: null, holder: null, model: null, glow: null, halo: null,
      removed: false,
    };
    this._build(p);
    this.list.push(p);
    this.stats.spawned++;
    return p;
  }

  /** Remove a pickup for good. */
  remove(p) {
    if (!p || p.removed) return;
    p.removed = true;
    p.active = false;
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    if (p.obj) {
      p.obj.removeFromParent();
      if (p.glow) p.glow.material.dispose();
      if (p.halo) p.halo.material.dispose();
    }
  }

  /** Active pickups (optionally filtered by kind). */
  active(kind = null) { return this.list.filter((p) => p.active && (!kind || p.kind === kind)); }

  // ================================================================================================ frame

  update(dt) {
    const g = this.game;
    const pl = g.player;
    const veh = pl && pl.inVehicle;
    const pp = pl && pl.position ? (veh && veh.position ? veh.position : pl.position) : null;
    const canCollect = !!(pl && pl.alive !== false && pp);
    const t = g.time || 0;
    this._settleBudget = 2;
    let blocked = null;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      // waiting to respawn
      if (!p.active) {
        if (p.respawn > 0) {
          p.respawnT -= dt;
          if (p.respawnT <= 0) this._reactivate(p);
        }
        continue;
      }
      // drop lifetime
      if (p.drop) {
        p.life -= dt;
        if (p.life <= 0) { this.remove(p); continue; }
      }
      const dx = pp ? pp.x - p.base.x : 0, dz = pp ? pp.z - p.base.z : 0;
      const d = pp ? Math.hypot(dx, dz) : 0;
      if (d > VIEW_R) { if (p.obj.visible) p.obj.visible = false; continue; }
      if (!p.settled && this._settleBudget > 0) this._settle(p);

      // collection animation
      if (p.collectT > 0) {
        p.collectT -= dt;
        const k = Math.max(0, p.collectT / 0.28);
        p.holder.position.y = FLOAT_Y + (1 - k) * 0.9;
        p.holder.scale.setScalar(Math.max(0.01, k) * MODEL_SCALE);
        if (p.glow) p.glow.material.opacity = 0.6 * k;
        if (p.collectT <= 0) this._finishCollect(p);
        continue;
      }

      p.obj.visible = true;
      // pop-in
      let s = 1;
      if (p.popT > 0) {
        p.popT = Math.max(0, p.popT - dt);
        const k = 1 - p.popT / 0.35;
        s = k < 1 ? Math.max(0.01, 1 + 0.35 * Math.sin(k * Math.PI) * (1 - k) - (1 - k) * (1 - k) * 0.9) : 1;
      }
      const bob = Math.sin(t * 2.4 + p.phase) * 0.09;
      p.holder.position.y = FLOAT_Y + bob;
      p.holder.rotation.y = t * 1.9 + p.phase;
      p.holder.scale.setScalar(s * MODEL_SCALE);
      if (p.glow) {
        p.glow.material.opacity = 0.42 + 0.14 * Math.sin(t * 3.3 + p.phase);
        p.glow.position.y = FLOAT_Y + bob;
      }
      // expiring drops blink
      if (p.drop && p.life < 5) p.holder.visible = Math.floor(p.life * 6) % 2 === 0;
      else p.holder.visible = true;

      if (!canCollect || d > 4) continue;
      // reach test: on foot 1.4 m; driving only for vehicle-collectable kinds
      let reach = false;
      if (veh) {
        if (p.vehicle) {
          const r = Math.max(2.2, (veh.radius || 1.5) + 0.7);
          reach = d < r && Math.abs(pp.y - p.base.y) < 3;
        }
      } else {
        reach = d < COLLECT_R && pp.y > p.base.y - 1.6 && pp.y < p.base.y + 1.9;
      }
      if (!reach) continue;
      const res = this._apply(p);
      if (res === true) this._startCollect(p);
      else if (typeof res === 'string') blocked = res;
    }

    // "Health full" style hint while standing on a pickup that cannot be taken
    if (blocked && g.hud && typeof g.hud.prompt === 'function') safe(() => g.hud.prompt(blocked));
  }

  // ================================================================================================ effects

  /** Apply the pickup's effect. Returns true when consumed, a string (reason) when refused, false otherwise. */
  _apply(p) {
    const g = this.game;
    const pl = g.player;
    const inv = g.inventory;
    const pos = p.base;
    switch (p.kind) {
      case 'cash': {
        if (typeof pl.addMoney !== 'function') return false;
        pl.addMoney(p.amount, 'pickup');
        sound(g, 'money', { volume: 0.9 });
        if (!p.silent && (!p.drop || p.amount >= 100)) notify(g, (p.label || 'Cash') + ' *+' + fmtMoney(p.amount) + '*', { duration: 2.5, color: '#5ee35a' });
        break;
      }
      case 'health': {
        const max = pl.maxHealth || 100;
        if ((pl.health || 0) >= max - 0.5) return 'Your health is already full.';
        const healed = typeof pl.heal === 'function' ? pl.heal(p.amount) : 0;
        sound(g, 'pickup');
        if (!p.silent) notify(g, 'Health *+' + Math.round(healed || p.amount) + '*', { duration: 2.2, color: '#ff4d5e' });
        break;
      }
      case 'armor': {
        const max = pl.maxArmor || 100;
        if ((pl.armor || 0) >= max - 0.5) return 'Your body armor is already full.';
        const added = typeof pl.addArmor === 'function' ? pl.addArmor(p.amount) : 0;
        sound(g, 'pickup');
        if (!p.silent) notify(g, 'Body armor *+' + Math.round(added || p.amount) + '*', { duration: 2.2, color: '#4d9bff' });
        break;
      }
      case 'weapon': {
        if (!inv || typeof inv.addWeapon !== 'function') return false;
        const had = typeof inv.hasWeapon === 'function' ? inv.hasWeapon(p.sub) : false;
        if (!inv.addWeapon(p.sub, p.amount)) return 'Your inventory is full.';
        sound(g, 'pickup');
        sound(g, 'reload', { volume: 0.5 });
        const w = WEAPONS[p.sub];
        const name = (w && w.name) || p.sub;
        if (!p.silent) notify(g, had ? name + ' ammo *+' + p.amount + '*' : 'Picked up a *' + name + '*', { duration: 2.6, color: '#ffb02e' });
        break;
      }
      case 'ammo': {
        if (!inv || typeof inv.addAmmo !== 'function') return false;
        const w = WEAPONS[p.sub];
        if (typeof inv.hasWeapon === 'function' && !inv.hasWeapon(p.sub)) return 'You need a ' + ((w && w.name) || p.sub) + ' for this ammo.';
        if (!inv.addAmmo(p.sub, p.amount)) return false;
        sound(g, 'pickup');
        if (!p.silent) notify(g, ((w && w.name) || p.sub) + ' ammo *+' + p.amount + '*', { duration: 2.2, color: '#e8c94a' });
        break;
      }
      case 'block': {
        if (!inv || typeof inv.addBlock !== 'function') return false;
        const ok = inv.addBlock(p.sub, p.amount);
        const over = Number(inv.lastOverflow) || 0;
        if (!ok && over >= p.amount) return 'Your inventory is full.';
        sound(g, 'pickup');
        const def = BLOCKS[p.sub];
        if (!p.silent) notify(g, '*+' + (p.amount - over) + '* ' + ((def && def.name) || 'blocks'), { duration: 2.2 });
        break;
      }
      case 'package': {
        if (p.onCollect) {
          let r;
          try { r = p.onCollect(p); } catch (e) { console.error('[pickups] onCollect', e); r = undefined; }
          if (r === false) return false;
        }
        sound(g, 'checkpoint');
        break;
      }
      default: return false;
    }
    if (p.kind !== 'package' && p.onCollect) { try { p.onCollect(p); } catch (e) { console.error('[pickups] onCollect', e); } }
    this.stats.collected++;
    _v.set(pos.x, pos.y + FLOAT_Y, pos.z);
    safe(() => g.fx && g.fx.burst && g.fx.burst(_v.clone(), { color: parseInt((PICKUP_COLORS[p.kind] || '#ffffff').slice(1), 16), count: 16, speed: 3.2, size: 0.09, life: 0.7, gravity: -1.5 }));
    g.events.emit('pickup', { type: p.type, amount: p.amount, position: _v.clone() });
    return true;
  }

  _startCollect(p) {
    p.collectT = 0.28;
  }

  _finishCollect(p) {
    p.collectT = 0;
    if (p.once && p.key) this.collectedOnce.add(p.key);
    if (p.respawn > 0) {
      p.active = false;
      p.respawnT = p.respawn;
      p.obj.visible = false;
    } else {
      this.remove(p);
    }
  }

  _reactivate(p) {
    p.active = true;
    p.popT = 0.35;
    p.holder.scale.setScalar(0.01);
    p.holder.visible = true;
    p.obj.visible = true;
  }

  // ================================================================================================ build / settle

  _build(p) {
    const g = this.game;
    const obj = new THREE.Group();
    obj.position.copy(p.base);
    const holder = new THREE.Group();
    holder.position.y = FLOAT_Y;
    let model = null;
    try { model = buildPickupModel(g, p.kind, p.sub); } catch (e) { model = null; }
    if (model) {
      if (p.kind === 'block' && p.amount >= 8) {
        // a little stack for crates of blocks
        const a = model, b2 = model.clone(), c2 = model.clone();
        a.position.set(-0.22, -0.12, 0); b2.position.set(0.22, -0.12, 0); c2.position.set(0, 0.3, 0);
        const st = new THREE.Group(); st.add(a, b2, c2); st.scale.setScalar(0.85);
        model = st;
      }
      holder.add(model);
    }
    obj.add(holder);
    const color = PICKUP_COLORS[p.kind] || '#ffffff';
    if (HAS_DOM) {
      p.glow = glowSprite(color, p.kind === 'cash' ? 1.25 : 1.45, 0.5);
      p.glow.position.y = FLOAT_Y;
      obj.add(p.glow);
      p.halo = groundHalo(color, 0.75, 0.4);
      p.halo.position.y = 0.04;
      obj.add(p.halo);
    }
    p.obj = obj;
    p.holder = holder;
    p.model = model;
    holder.scale.setScalar(0.01);
    (this.root || g.scene)?.add(obj);
  }

  /** Snap the pickup to the actual voxel ground near its hint height (roofs, caves, drops in mid-air). */
  _settle(p) {
    const w = this.game.world;
    if (!w || typeof w.isSolid !== 'function') { p.settled = true; return; }
    if (typeof w.isMeshedAt === 'function' && !safe(() => w.isMeshedAt(p.base.x, p.base.z), true)) return;
    this._settleBudget--;
    const hint = p.base.y;
    let best = null;
    const offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
    for (const [ox, oz] of offs) {
      const x = p.base.x + ox, z = p.base.z + oz;
      const y = groundNear(this.game, x, z, hint, p.drop ? 1.5 : 3);
      if (Number.isFinite(y) && Math.abs(y - hint) <= (p.drop ? 6 : 4) && !safe(() => w.isSolid(Math.floor(x), y, Math.floor(z)), false)) {
        best = { x, y, z };
        break;
      }
    }
    if (best) {
      p.base.set(best.x, best.y, best.z);
      p.obj.position.copy(p.base);
    }
    p.settled = true;
  }

  _scatterWorld() {
    const g = this.game;
    const plan = planOf(g);
    if (!plan) return;
    const specs = worldPickupSpecs(plan, g.seed || 1);
    for (const s of specs) {
      const respawn = Number.isFinite(s.respawn) && s.respawn >= 0 ? s.respawn : 120;
      // respawn 0 = one-time find: persistent until collected, then gone for good (remembered by the save)
      const p = this.spawn(s.type, { x: s.x, y: s.y, z: s.z }, s.amount, { respawn, persistent: respawn === 0, label: s.type === 'cash' ? 'Cash bundle' : null });
      if (!p) continue;
      p.tag = s.tag || 'world';
      if (respawn === 0) { p.once = true; p.key = p.tag + ':' + Math.round(s.x) + ',' + Math.round(s.z); }
    }
  }

  // ================================================================================================ save

  /** Collected one-time world pickups (hidden cash bundles): {collected: [key...]}. */
  serialize() {
    return { collected: [...this.collectedOnce] };
  }

  /** Remove the one-time world pickups a save already collected. */
  deserialize(o) {
    if (!o || !Array.isArray(o.collected)) return false;
    for (const k of o.collected) if (typeof k === 'string') this.collectedOnce.add(k);
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.once && p.key && this.collectedOnce.has(p.key)) this.remove(p);
    }
    return true;
  }

  // ================================================================================================ blips

  getBlips(out) {
    const g = this.game;
    const pp = g.player && g.player.position;
    if (!pp) return;
    for (const p of this.list) {
      if (!p.active || p.mission || p.collectT > 0) continue;
      if (p.kind !== 'weapon' && p.kind !== 'health' && p.kind !== 'armor') continue;
      const d = Math.hypot(p.base.x - pp.x, p.base.z - pp.z);
      if (d > BLIP_R) continue;
      // small plain dots, deliberately unlike the gun-shop / hospital icons (and the police's big blue dots)
      const st = PICKUP_BLIPS[p.kind];
      out.push({ x: p.base.x, z: p.base.z, shape: st.shape, color: st.color, size: st.size });
    }
  }

  // ================================================================================================ debug

  _installDebug() {
    const g = this.game;
    const d = g.debug;
    if (!d) return;
    const self = this;
    /** Spawn a pickup ~2.5 m in front of the player. */
    d.spawnPickup = (type = 'cash', amount, opts) => {
      const p = g.player;
      if (!p) return null;
      const yaw = g.cameraRig ? g.cameraRig.yaw : p.yaw || 0;
      const pk = self.spawn(type, { x: p.position.x + Math.sin(yaw) * 2.5, y: p.position.y, z: p.position.z + Math.cos(yaw) * 2.5 }, amount, opts || { persistent: true });
      return pk ? { id: pk.id, type: pk.type, amount: pk.amount, x: +pk.base.x.toFixed(2), y: pk.base.y, z: +pk.base.z.toFixed(2) } : null;
    };
    d.pickups = () => self.list.map((p) => ({ id: p.id, type: p.type, amount: p.amount, active: p.active, tag: p.tag || (p.drop ? 'drop' : ''), x: +p.base.x.toFixed(1), y: +p.base.y.toFixed(1), z: +p.base.z.toFixed(1) }));
    /** Teleport next to pickup #id (or the nearest of a type). */
    d.gotoPickup = (idOrType) => {
      const pk = typeof idOrType === 'number' ? self.list.find((p) => p.id === idOrType) : self.list.find((p) => p.type === idOrType || p.kind === idOrType);
      if (!pk) return null;
      d.teleport?.(pk.base.x + 2.2, pk.base.y, pk.base.z);
      return { id: pk.id, type: pk.type };
    };
  }
}
