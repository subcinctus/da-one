// Entity registry: every damageable / hittable thing in the world (player, peds, cops, vehicles, heli...)
// registers here so weapons, explosions, vehicles and AI can find each other without knowing owners.
//
// ENTITY INTERFACE (duck-typed; owners implement it):
//   id: number                      assigned by registry.add()
//   kind: 'player'|'ped'|'cop'|'vehicle'|'heli'|'tnt'|'prop'
//   team: 'player'|'civilian'|'police'|'gang'|'neutral'
//   position: THREE.Vector3         BOTTOM-CENTRE of the entity (feet for humanoids, ground contact for cars)
//   velocity: THREE.Vector3
//   radius: number                  horizontal half-extent (AABB half width) used for queries & default box
//   height: number
//   health: number, maxHealth: number, alive: boolean
//   damage(amount, info): void      info = { type: 'bullet'|'melee'|'explosion'|'vehicle'|'fall'|'fire'|'drown',
//                                            source: entity|null (who caused it; the player entity for player-caused damage),
//                                            point?: Vector3, dir?: Vector3, weapon?: string }
//                                   Implementations MUST emit game.events 'entityDamaged' {entity, amount, info}
//                                   and, on the transition to dead, 'entityKilled' {entity, info}.
//   knockback?(impulse: Vector3)    optional
//   getBox?(out: THREE.Box3): Box3  optional precise world AABB; default derived from position/radius/height
//   hidden?: boolean                when true, raycasts/queries skip it (e.g. player while inside a vehicle)
import * as THREE from 'three';

const _box = new THREE.Box3();
const _hit = new THREE.Vector3();
const _ray = new THREE.Ray();

export function defaultBox(e, out) {
  const p = e.position, r = e.radius;
  out.min.set(p.x - r, p.y, p.z - r);
  out.max.set(p.x + r, p.y + e.height, p.z + r);
  return out;
}

export function entityBox(e, out = new THREE.Box3()) {
  return e.getBox ? e.getBox(out) : defaultBox(e, out);
}

export class EntityRegistry {
  constructor() {
    this.list = [];
    this._nextId = 1;
  }

  add(e) {
    if (e.id == null) e.id = this._nextId++;
    if (!this.list.includes(e)) this.list.push(e);
    return e;
  }

  remove(e) {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Entities whose position is within `radius` (3D distance from centre-of-mass ≈ position + height/2). */
  query(center, radius, filter = null, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    for (const e of this.list) {
      if (e.hidden) continue;
      const dx = e.position.x - center.x, dy = e.position.y + e.height * 0.5 - center.y, dz = e.position.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2 && (!filter || filter(e))) out.push(e);
    }
    return out;
  }

  /** Closest entity matching filter within maxDist (horizontal distance). */
  nearest(center, maxDist, filter = null) {
    let best = null, bd = maxDist * maxDist;
    for (const e of this.list) {
      if (e.hidden || (filter && !filter(e))) continue;
      const dx = e.position.x - center.x, dz = e.position.z - center.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /**
   * Ray vs entity AABBs. origin/dir are Vector3 (dir normalised).
   * ignore: entity | entity[] | null. Returns { entity, distance, point } or null.
   */
  raycast(origin, dir, maxDist, ignore = null, filter = null) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    let best = null, bestD = maxDist;
    for (const e of this.list) {
      if (e.hidden || e === ignore || (Array.isArray(ignore) && ignore.includes(e))) continue;
      if (filter && !filter(e)) continue;
      // cheap bounding-sphere reject
      const cx = e.position.x - origin.x, cy = e.position.y + e.height * 0.5 - origin.y, cz = e.position.z - origin.z;
      const proj = cx * dir.x + cy * dir.y + cz * dir.z;
      const br = Math.max(e.radius, e.height) + 0.5;
      if (proj < -br || proj > bestD + br) continue;
      const perp2 = cx * cx + cy * cy + cz * cz - proj * proj;
      if (perp2 > br * br) continue;
      entityBox(e, _box);
      if (_ray.intersectBox(_box, _hit)) {
        const d = _hit.distanceTo(origin);
        if (d < bestD) { bestD = d; best = { entity: e, distance: d, point: _hit.clone() }; }
      }
    }
    return best;
  }
}
