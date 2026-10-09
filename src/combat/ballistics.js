// Hitscan ballistics (COMBAT): aim resolution, bullet tracing through glass, impact effects, damage application.
// Pure helpers + a Ballistics class bound to the game. No per-shot allocations except the hit records that the
// voxel / entity raycasts already create.
import * as THREE from 'three';
import { voxelRaycast } from '../core/physics.js';
import { BLOCKS, B } from '../world/blocks.js';

/** Blocks a bullet shatters and flies through. */
export const GLASS_IDS = new Set([B.GLASS, B.WINDOW, B.WINDOW_LIT].filter((v) => v !== undefined));
const MAX_PANES = 3;
const HUMANOID_KINDS = new Set(['player', 'ped', 'cop', 'swat', 'gang']);

export const isVehicle = (e) => !!e && (e.kind === 'vehicle' || e.kind === 'heli');
export const isHumanoid = (e) => !!e && (HUMANOID_KINDS.has(e.kind) || !!e.humanoid);

/** Entities a bullet can hit: living things plus vehicles / wrecks. Primed TNT and corpses are skipped. */
export const bulletFilter = (e) => e.kind !== 'tnt' && (e.alive !== false || isVehicle(e));

const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);

/**
 * Random direction inside a cone of half-angle `angle` (radians) around unit `dir`, written into `out`.
 * focus > 1 concentrates hits toward the centre (1 = uniform over the disk).
 */
export function spreadDir(dir, angle, out, focus = 1) {
  out.copy(dir);
  if (!(angle > 0)) return out;
  _u.crossVectors(dir, Math.abs(dir.y) < 0.98 ? _up : _xAxis).normalize();
  _w.crossVectors(_u, dir);
  const r = Math.tan(angle * Math.pow(Math.random(), 0.5 * focus));
  const th = Math.random() * Math.PI * 2;
  out.addScaledVector(_u, Math.cos(th) * r).addScaledVector(_w, Math.sin(th) * r);
  return out.normalize();
}

/** Damage multiplier for distance d with weapon falloff fields. */
export function falloff(def, d) {
  const start = def.falloffStart ?? def.range ?? 100;
  const range = def.range ?? 100;
  if (d <= start || range <= start) return 1;
  const t = Math.min(1, (d - start) / (range - start));
  return 1 + ((def.falloffMin ?? 0.5) - 1) * t;
}

/** Closest point of an entity's box to p (for explosions / melee). */
export function closestPointOnBox(box, p, out) {
  return out.set(
    Math.max(box.min.x, Math.min(p.x, box.max.x)),
    Math.max(box.min.y, Math.min(p.y, box.max.y)),
    Math.max(box.min.z, Math.min(p.z, box.max.z)),
  );
}

/**
 * Trace result record (reused per call by the caller):
 *   kind: 'entity' | 'block' | 'water' | 'none'
 *   entity, point (Vector3), normal (Vector3), distance, block {x,y,z,id} | null, panes (glass shattered)
 */
export function makeTraceRecord() {
  return { kind: 'none', entity: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, block: null, panes: 0 };
}

export class Ballistics {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this._pos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._sndT = 0;
    this._glassSndT = 0;
  }

  /** Frame tick (sound rate limiting). */
  update(dt) {
    this._sndT -= dt;
    this._glassSndT -= dt;
  }

  /**
   * Point the aim ray hits (entities, then solid blocks / water), starting `startT` metres along the ray.
   * Writes it into `out` and returns the kind of thing hit ('entity'|'block'|'none').
   */
  resolveAim(origin, dir, range, ignore, startT, out) {
    const g = this.game, w = g.world;
    const s = this._pos.copy(origin).addScaledVector(dir, Math.max(0, startT || 0));
    let vh = null;
    if (w) { try { vh = voxelRaycast(w, s, dir, range, { hitNonSolid: false, hitLiquid: true }); } catch (e) { vh = null; } }
    // a ray that starts inside a block (hugging a wall) still aims at that wall
    const maxD = vh ? vh.distance : range;
    let eh = null;
    const ents = g.entities;
    if (ents && ents.raycast) { try { eh = ents.raycast(s, dir, Math.max(0.01, maxD), ignore, bulletFilter); } catch (e) { eh = null; } }
    if (eh) { out.copy(eh.point); return 'entity'; }
    if (vh) { out.copy(vh.point); return 'block'; }
    out.copy(s).addScaledVector(dir, range);
    return 'none';
  }

  /**
   * Trace one bullet from origin along unit dir. Shatters up to 3 glass panes on the way (and keeps going),
   * primes TNT, splashes water, and spawns impact FX / sounds on blocks. Entity hits are only REPORTED (the caller
   * aggregates pellets and applies damage). Returns `rec`.
   */
  trace(origin, dir, range, ignore, shooter, rec) {
    const g = this.game, w = g.world, ents = g.entities;
    rec.kind = 'none'; rec.entity = null; rec.block = null; rec.panes = 0; rec.distance = range;
    rec.normal.set(0, 0, 0);
    const pos = this._tmp.copy(origin);
    let traveled = 0;
    let remaining = range;
    for (let guard = 0; guard < MAX_PANES + 2; guard++) {
      let vh = null;
      if (w) { try { vh = voxelRaycast(w, pos, dir, remaining, { hitNonSolid: false, hitLiquid: true }); } catch (e) { vh = null; } }
      let eh = null;
      if (ents && ents.raycast) {
        try { eh = ents.raycast(pos, dir, Math.max(0.01, vh ? vh.distance : remaining), ignore, bulletFilter); } catch (e) { eh = null; }
      }
      if (eh) {
        rec.kind = 'entity'; rec.entity = eh.entity; rec.point.copy(eh.point);
        rec.distance = traveled + eh.distance;
        rec.normal.copy(dir).negate();
        return rec;
      }
      if (!vh) break;
      const def = BLOCKS[vh.id];
      if (GLASS_IDS.has(vh.id) && rec.panes < MAX_PANES) {
        this.shatter(vh.x, vh.y, vh.z, vh.id, shooter, dir);
        rec.panes++;
        const step = vh.distance + 0.02;
        pos.addScaledVector(dir, step);
        traveled += step;
        remaining -= step;
        if (remaining <= 0.05) break;
        continue;
      }
      rec.point.copy(vh.point);
      rec.normal.copy(vh.normal);
      if (rec.normal.lengthSq() < 0.5) rec.normal.copy(dir).negate();
      rec.distance = traveled + vh.distance;
      rec.block = { x: vh.x, y: vh.y, z: vh.z, id: vh.id };
      if (def && def.liquid) {
        rec.kind = 'water';
        this._waterHit(vh.point);
        return rec;
      }
      rec.kind = 'block';
      if (vh.id === B.TNT) {
        this.combat.primeTNT(vh.x, vh.y, vh.z, shooter, { cause: 'shot' });
      } else {
        this._blockImpact(vh.point, rec.normal, vh.id);
      }
      return rec;
    }
    rec.kind = 'none';
    rec.point.copy(origin).addScaledVector(dir, range);
    rec.distance = range;
    return rec;
  }

  /** Break a glass / window block with shards + sound. */
  shatter(x, y, z, id, shooter, dir) {
    const g = this.game, w = g.world;
    if (!w || typeof w.setBlock !== 'function') return false;
    let ok = false;
    try { ok = w.setBlock(x, y, z, 0) !== false; } catch (e) { ok = false; }
    if (!ok) return false;
    const c = this._pos.set(x + 0.5, y + 0.5, z + 0.5);
    try { g.fx?.blockBreak?.(x, y, z, id); } catch (e) { /* fx stub */ }
    try {
      g.fx?.burst?.(c, { color: id === B.WINDOW_LIT ? 0xfff0b0 : 0xd8f0ff, count: 10, speed: 3.5, size: 0.06, life: 0.9, gravity: 22 });
    } catch (e) { /* fx stub */ }
    if (this._glassSndT <= 0) {
      this._glassSndT = 0.05;
      g.audio?.play?.('glass_break', { position: c, volume: 0.85, pitch: 0.9 + Math.random() * 0.25 });
    }
    g.events.emit('blockBroken', { x, y, z, id, byPlayer: !!shooter && shooter === g.player, cause: 'bullet' });
    return true;
  }

  _blockImpact(point, normal, id) {
    const g = this.game;
    try { g.fx?.impact?.(point, normal, id); } catch (e) { /* fx stub */ }
    if (this._sndT <= 0) {
      this._sndT = 0.03;
      const def = BLOCKS[id];
      const hard = def && (def.hardness >= 3 || def.tool === 'pickaxe');
      g.audio?.play?.('bullet_impact', { position: point, volume: hard ? 0.55 : 0.4, pitch: hard ? 1.1 + Math.random() * 0.2 : 0.75 + Math.random() * 0.15 });
    }
  }

  _waterHit(point) {
    const g = this.game;
    try { g.fx?.burst?.(point, { color: 0xbfdcff, count: 8, speed: 3.2, size: 0.07, life: 0.6, gravity: 20 }); } catch (e) { /* fx */ }
    if (this._sndT <= 0) {
      this._sndT = 0.05;
      g.audio?.play?.('splash', { position: point, volume: 0.25, pitch: 1.6 + Math.random() * 0.3 });
    }
  }

  /**
   * Apply one shot's accumulated damage to an entity (pellets merged), with blood / sparks and knockback.
   * hit = { entity, damage, point, dir, headshot }. Returns true if the entity died from it.
   */
  applyEntityHit(hit, shooter, def) {
    const g = this.game;
    const e = hit.entity;
    if (!e || typeof e.damage !== 'function' || !(hit.damage > 0)) return false;
    const wasAlive = e.alive !== false;
    const info = {
      type: 'bullet', source: shooter || null, point: hit.point.clone(), dir: hit.dir.clone(), weapon: def.id,
      headshot: !!hit.headshot, normal: this._tmp.copy(hit.dir).negate().clone(),
    };
    try { e.damage(hit.damage, info); } catch (err) { console.warn('[combat] damage() threw', err); }
    if (isVehicle(e)) {
      try { g.fx?.sparks?.(hit.point, info.normal); } catch (err) { /* fx */ }
      g.audio?.play?.('bullet_impact', { position: hit.point, volume: 0.5, pitch: 1.5 + Math.random() * 0.3 });
    } else if (isHumanoid(e)) {
      // peds spray their own blood in damage(); everyone else (player, cops, dummies) gets it here
      if (e.kind !== 'ped' || hit.headshot) { try { g.fx?.blood?.(hit.point, hit.dir); } catch (err) { /* fx */ } }
      if (hit.headshot) {
        try { g.fx?.burst?.(hit.point, { color: 0x8a0a0a, count: 8, speed: 4, size: 0.07, life: 0.7, gravity: 18 }); } catch (err) { /* fx */ }
      }
    }
    const killed = wasAlive && e.alive === false;
    // heavy rounds shove people; kills fling them a little (ragdoll-ish)
    const kb = (def.knockback || 0) * (hit.pellets ? Math.min(1, hit.pellets / 4) * 3 : 1);
    if (typeof e.knockback === 'function' && !isVehicle(e) && (kb > 0 || killed)) {
      const k = (kb || 1.2) * (killed ? 1.8 : 1);
      try { e.knockback(this._tmp.set(hit.dir.x * k, killed ? 1.5 : 0.4, hit.dir.z * k).clone()); } catch (err) { /* ignore */ }
    }
    return killed;
  }
}
