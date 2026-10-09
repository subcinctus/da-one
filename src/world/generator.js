// STUB - to be replaced by the WORLD-GEN agent. See ARCHITECTURE.md §Generator.
import { WORLD, voxelIndex } from '../core/config.js';
import { B } from './blocks.js';
export class Generator {
  constructor(game, seed) { this.game = game; this.seed = seed; this.plan = null; }
  init() {
    this.plan = {
      seed: this.seed, sizeX: WORLD.SIZE_X, sizeZ: WORLD.SIZE_Z, nodes: [], roads: [], lots: [], pois: [], parkingSpots: [],
      sidewalkWidth: 3, spawn: { x: 256.5, y: WORLD.CITY_LEVEL, z: 256.5, yaw: 0 },
      surfaceY: () => WORLD.CITY_LEVEL, isRoad: () => false, isSidewalk: () => false, isWater: () => false,
      lotAt: () => null, districtAt: () => ({ id: 'city', name: 'Block City' }), colorAt: () => 0x5d9b3a,
      nearestNode: () => null, roadAt: () => null, poisOfType: () => [],
    };
  }
  generateChunk(cx, cz) {
    const C = WORLD.CHUNK, data = new Uint8Array(C * C * WORLD.HEIGHT);
    for (let y = 0; y < WORLD.CITY_LEVEL; y++) for (let z = 0; z < C; z++) for (let x = 0; x < C; x++)
      data[voxelIndex(x, y, z)] = y === 0 ? B.BEDROCK : y === WORLD.CITY_LEVEL - 1 ? B.GRASS : B.STONE;
    return data;
  }
}
