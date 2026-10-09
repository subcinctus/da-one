// Explosions (COMBAT): carve the voxel world, chain-prime TNT, hurt + fling entities, FX/audio/shake, events.
import * as THREE from 'three';
import { B, BLOCKS } from '../world/blocks.js';
import { hasLineOfSight } from '../core/physics.js';
import { entityBox } from '../core/entities.js';
import { isVehicle, isHumanoid, closestPointOnBox } from './ballistics.js';

const MAX_DEPTH = 6;
const _box = new THREE.Box3();
const _cp = new THREE.Vector3();
const _ctr = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cam = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Explosion at `position` (Vector3). opts: {radius = 4, power = 3, damage = 100, source = null, weapon?}.
 * Returns {removed: Array<{x,y,z,id}>, hit: entity[]}.
 */
export function doExplode(combat, position, opts = {}) {
  const g = combat.game;
  const result = { removed: [], hit: [] };
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return result;
  const radius = clamp(Number(opts.radius) || 4, 0.5, 16);
  const power = Number.isFinite(opts.power) ? opts.power : 3;
  const damage = Number.isFinite(opts.damage) ? opts.damage : 100;
  const source = opts.source || null;
  const pos = new THREE.Vector3().copy(position);
  const pk = clamp((power || 1) / 3, 0.6, 1.5);   // blast strength scale for knockback / shake
  combat._explodeDepth = (combat._explodeDepth || 0) + 1;
  try {
    // ---------------------------------------------------------------- 1. world
    let removed = [];
    const w = g.world;
    if (w && typeof w.explode === 'function' && power > 0) {
      try { removed = w.explode(pos, radius, power) || []; } catch (e) { console.warn('[combat] world.explode failed', e); removed = []; }
    }
    result.removed = removed;

    // ---------------------------------------------------------------- 2. chain reaction + block debris
    let glass = 0;
    const debris = [];
    for (let i = 0; i < removed.length; i++) {
      const b = removed[i];
      if (b.id === B.TNT) {
        combat.tnt.prime(b.x, b.y, b.z, source, { fuse: rand(1.5, 3), removeBlock: false, blast: pos });
      } else if (b.id === B.GLASS || b.id === B.WINDOW || b.id === B.WINDOW_LIT) glass++;
      else if (debris.length < 7 && Math.random() < Math.max(0.08, 10 / (removed.length + 1))) debris.push(b);
    }
    const cam = g.camera;
    if (cam && debris.length) {
      _cam.setFromMatrixPosition(cam.matrixWorld);
      if (_cam.distanceToSquared(pos) < 90 * 90) {
        for (const b of debris) { try { g.fx?.blockBreak?.(b.x, b.y, b.z, b.id); } catch (e) { /* fx */ } }
      }
    }

    // ---------------------------------------------------------------- 3. entities
    const ents = g.entities;
    const list = ents && ents.query ? ents.query(pos, radius + 4, null, []) : [];
    for (const e of list) {
      if (!e || e.hidden || e.removed) continue;
      let box;
      try { box = entityBox(e, _box); } catch (err) { continue; }
      closestPointOnBox(box, pos, _cp);
      const d = _cp.distanceTo(pos);
      if (d > radius) continue;
      let f = 1 - d / radius;
      _ctr.set((box.min.x + box.max.x) * 0.5, (box.min.y + box.max.y) * 0.5, (box.min.z + box.max.z) * 0.5);
      // cover: walls that survived the blast shield most of it
      if (w && d > 0.6) {
        let los = true;
        try { los = hasLineOfSight(w, pos, _ctr); } catch (err) { los = true; }
        if (!los) f *= 0.35;
      }
      if (f <= 0.01) continue;
      // locals (a vehicle blowing up inside damage() re-enters this function and reuses the module temps)
      let dx = _ctr.x - pos.x, dz = _ctr.z - pos.z;
      const hl = Math.hypot(dx, dz);
      if (hl > 1e-3) { dx /= hl; dz /= hl; } else { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
      if (e.kind === 'tnt') {
        // TNT lit by this very blast was already launched by prime(); older lit TNT gets thrown around
        if (e.age > 0) { try { e.knockback?.(new THREE.Vector3(dx * 9 * f, 5 * f + 1, dz * 9 * f)); } catch (err) { /* ignore */ } }
        continue;
      }
      const veh = isVehicle(e);
      let imp = null;
      if (typeof e.knockback === 'function') {
        if (veh) imp = new THREE.Vector3(dx * 9 * f * pk, (8 * f + 3) * pk, dz * 9 * f * pk);
        else if (isHumanoid(e)) imp = new THREE.Vector3(dx * 13 * f * pk, (6 * f + 2) * pk, dz * 13 * f * pk);
        else imp = new THREE.Vector3(dx * 8 * f, 4 * f + 1, dz * 8 * f);
      }
      const amount = damage * f * (veh ? 1.5 : 1);
      if (amount > 0.5 && typeof e.damage === 'function') {
        const info = { type: 'explosion', source, point: pos.clone(), dir: _dir.set(dx, 0.4, dz).normalize().clone(), weapon: opts.weapon || null };
        try { e.damage(amount, info); } catch (err) { console.warn('[combat] explosion damage() threw', err); }
        result.hit.push(e);
      }
      if (imp) { try { e.knockback(imp); } catch (err) { /* ignore */ } }
    }

    // ---------------------------------------------------------------- 4. FX, audio, camera
    try { g.fx?.explosion?.(pos, radius); } catch (e) { /* fx stub */ }
    const a = g.audio;
    if (a && a.play) {
      a.play('explosion', { position: pos, volume: clamp(0.75 + power * 0.1 + radius * 0.02, 0.7, 1.25), pitch: clamp(1.15 - radius * 0.04, 0.8, 1.1) * rand(0.94, 1.06) });
      if (glass > 0) a.play('glass_break', { position: pos, volume: Math.min(1, 0.5 + glass * 0.05) });
    }
    const rig = g.cameraRig;
    if (rig && typeof rig.shake === 'function' && cam) {
      _cam.setFromMatrixPosition(cam.matrixWorld);
      const dc = _cam.distanceTo(pos);
      const k = clamp(1 - dc / (radius * 8), 0, 1);
      // FX adds its own trauma; this is the extra "it was close" thump (the full amount when FX is missing)
      const amt = g.fx && g.fx.explosion ? 0.45 * k * k * pk : k * pk;
      if (amt > 0.01) { try { rig.shake(Math.min(1, amt)); } catch (e) { /* ignore */ } }
    }

    // ---------------------------------------------------------------- 5. events
    g.events.emit('explosion', { position: pos.clone(), radius, power, source, removed: removed.length, blocks: removed, weapon: opts.weapon || null });
    if (source && source === g.player) {
      g.events.emit('crime', { type: 'explosion', position: pos.clone(), severity: power >= 4 ? 2 : 1 });
    }
  } finally {
    combat._explodeDepth--;
  }
  return result;
}

/** Explosion depth guard: deeper chains are deferred to the next frame by Combat. */
export const EXPLODE_MAX_DEPTH = MAX_DEPTH;

/** Removed blocks of a given id (helper for tests / missions). */
export function countRemoved(removed, id) {
  let n = 0;
  for (const b of removed) if (b.id === id) n++;
  return n;
}

/** True when a block id is destroyed by an explosion of `power`. */
export function blastBreaks(id, power) {
  const d = BLOCKS[id];
  if (!d || id === 0 || d.liquid || id === B.BEDROCK) return false;
  const blast = typeof d.blast === 'number' ? d.blast : 1;
  return blast <= power;
}
