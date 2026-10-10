// World generator (WORLD-GEN agent). See ARCHITECTURE.md §Generator and §4.1.
//
//   const gen = new Generator(game, seed); gen.init();   // builds gen.plan (city plan + O(1) queries) in < 1.5 s
//   const voxels = gen.generateChunk(cx, cz);             // Uint8Array(16*16*96), pure function of (seed, cx, cz)
//
// Files: gen_const (constants), gen_layout (road graph, lots, POIs), gen_terrain (heightmap), gen_plan (rasters,
// tunnels/bridges, features, map colours, queries), gen_build_* (building blueprints), gen_structures (mine, beach,
// pier), gen_features (trees/lamps), gen_chunk (voxel fill).
import { DEFAULT_SEED } from '../core/config.js';
import { buildPlan } from './gen_plan.js';
import { ChunkGen } from './gen_chunk.js';

export class Generator {
  constructor(game, seed) {
    this.game = game || null;
    this.seed = (Number.isFinite(seed) ? seed : DEFAULT_SEED) >>> 0;
    /** City plan (§4.1). Built by init(). */
    this.plan = null;
    this.internal = null;
    this._gen = null;
    this.stats = { chunks: 0, chunkMs: 0, maxChunkMs: 0, planMs: 0 };
  }

  /** Build the plan deterministically from the seed. */
  init(onProgress) {
    if (this.plan) return;
    if (onProgress) { try { onProgress(0.1, 'Surveying the land...'); } catch { /* ignore */ } }
    const t0 = now();
    const { plan, internal } = buildPlan(this.seed);
    this.plan = plan;
    this.internal = internal;
    this._gen = new ChunkGen(this.seed, internal);
    this.stats.planMs = Math.round(now() - t0);
    if (onProgress) { try { onProgress(1, 'City planned'); } catch { /* ignore */ } }
    this._installDebug();
  }

  /** Voxels of chunk (cx, cz): Uint8Array(16*16*96), index = lx + lz*16 + y*256. Pure function of (seed, cx, cz). */
  generateChunk(cx, cz) {
    if (!this._gen) this.init();
    const t0 = now();
    const data = this._gen.generate(cx, cz);
    const dt = now() - t0;
    this.stats.chunks++;
    this.stats.chunkMs += dt;
    if (dt > this.stats.maxChunkMs) this.stats.maxChunkMs = dt;
    return data;
  }

  /** Standing height of the terrain/street at a column (shortcut for plan.surfaceY). */
  surfaceY(x, z) { return this.plan ? this.plan.surfaceY(x, z) : 28; }

  _installDebug() {
    const game = this.game;
    if (!game || !game.debug) return;
    const plan = this.plan;
    const self = this;
    const tp = (x, y, z) => { try { game.debug.teleport(x, y, z); } catch { /* player not ready */ } };
    /** Teleport to a POI by type (index for repeated types). */
    game.debug.gotoPoi = (type, index = 0) => {
      const p = plan.poisOfType(type)[index];
      if (!p) return null;
      tp(p.x, p.y, p.z);
      if (game.player) game.player.yaw = p.yaw;
      if (game.cameraRig) game.cameraRig.yaw = p.yaw;
      return p;
    };
    /** Teleport to a district centre. */
    game.debug.gotoDistrict = (id) => {
      const d = plan.districts.find((q) => q.id === id);
      if (!d) return null;
      const n = plan.nearestNode(d.x, d.z);
      const x = n && plan.districtAt(n.x, n.z).id === id ? n.x + 0.5 : d.x + 0.5;
      const z = n && plan.districtAt(n.x, n.z).id === id ? n.z + 0.5 : d.z + 0.5;
      tp(x, plan.surfaceY(x, z) + 0.01, z);
      return d;
    };
    /** Info about what the generator put at a column (defaults to the player position). */
    game.debug.where = (x, z) => {
      if (x === undefined && game.player) { x = game.player.position.x; z = game.player.position.z; }
      const lot = plan.lotAt(x, z), road = plan.roadAt(x, z);
      return {
        x, z, district: plan.districtAt(x, z).name, surfaceY: plan.surfaceY(x, z), road: road ? { id: road.id, kind: road.kind } : null,
        sidewalk: plan.isSidewalk(x, z), water: plan.isWater(x, z), tunnel: plan.isTunnel(x, z), bridge: plan.isBridge(x, z),
        lot: lot ? { id: lot.id, type: lot.type, style: lot.style, height: lot.height } : null,
      };
    };
    /** Generator stats: plan timing, chunk timing, counts. */
    game.debug.genStats = () => ({
      planMs: self.stats.planMs, planTiming: self.internal.timing, chunks: self.stats.chunks,
      avgChunkMs: self.stats.chunks ? +(self.stats.chunkMs / self.stats.chunks).toFixed(3) : 0, maxChunkMs: +self.stats.maxChunkMs.toFixed(2),
      nodes: plan.nodes.length, roads: plan.roads.length, lots: plan.lots.length, pois: plan.pois.length, parkingSpots: plan.parkingSpots.length,
    });
    /** Render plan.colorAt into a canvas (debug / tests). */
    game.debug.mapCanvas = (scale = 1) => {
      if (typeof document === 'undefined') return null;
      const c = document.createElement('canvas');
      c.width = c.height = 512 * scale;
      const g = c.getContext('2d');
      const img = g.createImageData(512, 512);
      for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) {
        const col = plan.colorAt(x, z), k = (z * 512 + x) * 4;
        img.data[k] = (col >> 16) & 255; img.data[k + 1] = (col >> 8) & 255; img.data[k + 2] = col & 255; img.data[k + 3] = 255;
      }
      if (scale === 1) { g.putImageData(img, 0, 0); return c; }
      const t = document.createElement('canvas'); t.width = t.height = 512; t.getContext('2d').putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false; g.drawImage(t, 0, 0, 512 * scale, 512 * scale);
      return c;
    };
  }
}

function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }
