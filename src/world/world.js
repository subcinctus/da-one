// STUB - to be replaced by the WORLD-ENGINE agent. See ARCHITECTURE.md §World.
import { WORLD } from '../core/config.js';
import { voxelRaycast, findGround } from '../core/physics.js';
import { BLOCKS } from './blocks.js';
export class World {
  constructor(game) { this.game = game; this.chunks = new Map(); this.edits = new Map(); }
  init() {}
  getBlock(x, y, z) { return y < 0 ? 1 : (y < WORLD.CITY_LEVEL ? 2 : 0); }
  isSolid(x, y, z) {
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= WORLD.SIZE_X || z >= WORLD.SIZE_Z) return y < WORLD.HEIGHT;
    const id = this.getBlock(x, y, z); return !!(BLOCKS[id] && BLOCKS[id].solid);
  }
  setBlock() { return false; }
  raycast(origin, dir, maxDist, opts) { return voxelRaycast(this, origin, dir, maxDist, opts); }
  findGround(x, z, startY) { return findGround(this, x, z, startY); }
  explode() { return []; }
  update() {}
}
