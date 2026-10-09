// Voxel world engine (WORLD-ENGINE, see ARCHITECTURE.md §World): chunk data store, block queries/edits,
// explosions, chunk streaming + meshing, materials and the procedural texture atlas.
//
// Public API (contract): init(onProgress), chunks, edits, getBlock, isSolid, setBlock, raycast, findGround, explode,
// applyEdits, update, textures.
// Extras: lateUpdate (same-frame remesh of edits), getChunk, getBlockDef, isLiquid, isOpaque, isMeshedAt, columnTop,
// serializeEdits, materials, group, stats(), remeshAll(); debug: game.debug.remeshAll(), game.debug.worldStats(), ...
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { voxelRaycast, findGround as physFindGround } from '../core/physics.js';
import { BLOCKS, B } from './blocks.js';
import { TextureAtlas } from './textures.js';
import {
  buildTables, fillPad, meshSection, mergeParts, createEnv, prepareEnv, LIGHT_SOURCES, SKY_K, COVERED_LIGHT,
  PAD_LEN, SECTIONS, SECTION_H,
} from './mesher.js';

const C = WORLD.CHUNK;                 // 16
const H = WORLD.HEIGHT;                // 96
const NX = WORLD.SIZE_X / C;           // 32
const NZ = WORLD.SIZE_Z / C;           // 32
const CHUNK_LEN = C * C * H;
const ALL_SECTIONS = (1 << SECTIONS) - 1;
const PASSES = ['opaque', 'transparent'];
const STREAM_BUDGET_MS = 4;
const URGENT_BUDGET_MS = 10;
const DAY_GLOW = 0.04;
const NIGHT_GLOW = 1.15;
const FORCE_RADIUS = 1.5;   // chunks this close to the centre ignore the frame budget
const FORWARD_BIAS = 0.35;  // load-order preference for chunks in the view direction
const KEEP_PARTS_R = 3;      // chunks within this radius keep per-section mesh data for fast edits
const NIGHT_LAMP = 2.3;     // strength of lamp/neon light pools at night
const MAX_LIGHT_R = Math.ceil(Math.max(...Object.values(LIGHT_SOURCES).map((l) => l.R)));
const _fwd = new THREE.Vector3();

// per-id lookup tables (rebuilt in the constructor so blocks appended to the registry are covered)
const SOLID = new Uint8Array(256);
const LIQUID = new Uint8Array(256);
const OPAQUE = new Uint8Array(256);
const CROSS = new Uint8Array(256);
const BLAST = new Float32Array(256);
const LIGHTSRC = new Uint8Array(256);
function buildIdTables() {
  SOLID.fill(0); LIQUID.fill(0); OPAQUE.fill(0); CROSS.fill(0); BLAST.fill(Infinity); LIGHTSRC.fill(0);
  for (const d of BLOCKS) {
    if (!d || d.id > 255) continue;
    SOLID[d.id] = d.solid ? 1 : 0;
    LIQUID[d.id] = d.liquid ? 1 : 0;
    OPAQUE[d.id] = d.opaque ? 1 : 0;
    CROSS[d.id] = d.shape === 'cross' ? 1 : 0;
    BLAST[d.id] = typeof d.blast === 'number' ? d.blast : 1;
    LIGHTSRC[d.id] = LIGHT_SOURCES[d.key] ? 1 : 0;
  }
}

/** Per column: 1 + y of the highest opaque block (0 = open to the sky). */
function computeHeights(d) {
  const h = new Uint8Array(256);
  for (let col = 0; col < 256; col++) {
    for (let y = H - 1; y >= 0; y--) if (OPAQUE[d[col | (y << 8)]]) { h[col] = y + 1; break; }
  }
  return h;
}

/** Light-source blocks of a chunk: [[lx, y, lz, id], ...]. */
function scanLights(d) {
  const out = [];
  for (let i = 0; i < d.length; i++) if (LIGHTSRC[d[i]]) out.push([i & 15, i >> 8, (i >> 4) & 15, d[i]]);
  return out;
}

const noRaycast = () => {};
function disposeArray() { this.array = null; }
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Flat fallback terrain used when the generator is missing or fails (never leaves holes). */
function fallbackChunk() {
  const d = new Uint8Array(CHUNK_LEN);
  const top = WORLD.CITY_LEVEL - 1;
  for (let y = 0; y <= top; y++) {
    const id = y === 0 ? B.BEDROCK : y === top ? B.GRASS : y > top - 4 ? B.DIRT : B.STONE;
    d.fill(id, y * 256, y * 256 + 256);
  }
  return d;
}

export class World {
  constructor(game) {
    this.game = game;
    /** Map<'cx,cz', chunk>: every chunk whose voxel data exists. chunk = {key, cx, cz, data, meshes[], dirty, meshed}. */
    this.chunks = new Map();
    /** Player-made changes Map<'x,y,z', id> (saved by SaveSystem). */
    this.edits = new Map();
    /** Procedural block atlas (see textures.js). Layout + uvFor work before init(). */
    this.textures = new TextureAtlas();
    this.materials = null;
    this.group = new THREE.Group();
    this.group.name = 'world';
    this.group.matrixAutoUpdate = false;
    /** Streaming keeps running on the title screen / pause menu (centre = camera). */
    this.runWhenPaused = true;
    this.ready = false;
    this.renderDistance = 6;
    this.shadows = false;

    buildIdTables();
    this._datas = new Array(NX * NZ).fill(null);
    this._chunkArr = new Array(NX * NZ).fill(null);
    this._pending = new Map();        // chunk index -> [[voxelIndex, id], ...] edits for chunks not generated yet
    this._pad = new Uint8Array(PAD_LEN);
    this._tables = null;
    this._offX = new Int16Array(0);
    this._offZ = new Int16Array(0);
    this._offD = new Float32Array(0);
    this._cursor = 0;
    this._order = null;
    this._score = null;
    this._orderYaw = 0;
    this._ccx = -999; this._ccz = -999;
    this._urgent = new Set();
    this._work = 0;
    this._frame = 0;
    this._initing = false;
    this._lastGen = null;
    this._genErrorLogged = false;
    this._unsub = [];
    /** Shader uniforms shared by the chunk materials (see _patchMaterial). */
    this._uniforms = { uGlow: { value: DAY_GLOW }, uLamp: { value: 0 }, uCovered: { value: COVERED_LIGHT } };
    this._glow = this._uniforms.uGlow;
    this._env = createEnv();
    this._getHeights = (cx, cz) => {
      const ch = this.getChunk(cx, cz);
      if (!ch) return null;
      return ch.height || (ch.height = computeHeights(ch.data));
    };
    this._getLights = (cx, cz) => {
      const ch = this.getChunk(cx, cz);
      if (!ch) return null;
      return ch.lights || (ch.lights = scanLights(ch.data));
    };
    this._stats = { genCount: 0, genMs: 0, genMax: 0, meshCount: 0, meshMs: 0, meshMax: 0, lastMeshMs: 0, sectionCount: 0 };
  }

  // ============================================================================================ lifecycle

  /** Build the atlas + materials, then pre-generate and mesh the spawn area (radius = renderDistance). */
  async init(onProgress) {
    const game = this.game;
    const progress = (p, t) => { try { if (onProgress) onProgress(p, t); } catch (e) { /* loading screen broken */ } };
    progress(0, 'Painting block textures...');
    this.textures.init(game.renderer);
    this._tables = buildTables(this.textures);
    this._makeMaterials();
    if (game.scene && !this.group.parent) game.scene.add(this.group);
    this._applySettings(game.settings || {}, true);
    this._installDebug();
    if (game.events && game.events.on) {
      this._unsub.push(game.events.on('settingsChanged', (s) => this._applySettings(s || game.settings || {}, false)));
    }

    // spawn area
    const plan = game.generator && game.generator.plan;
    const sp = (plan && plan.spawn) || { x: WORLD.SIZE_X / 2, z: WORLD.SIZE_Z / 2 };
    const ccx = clamp(Math.floor(sp.x / C), 0, NX - 1), ccz = clamp(Math.floor(sp.z / C), 0, NZ - 1);
    this._ccx = ccx; this._ccz = ccz; this._cursor = 0;
    const list = [];
    for (let k = 0; k < this._offX.length; k++) {
      const cx = ccx + this._offX[k], cz = ccz + this._offZ[k];
      if (cx >= 0 && cz >= 0 && cx < NX && cz < NZ) list.push([cx, cz]);
    }
    let last = performance.now();
    this._initing = true;
    try {
      for (let k = 0; k < list.length; k++) {
        const [cx, cz] = list[k];
        this._ensureNeighbourData(cx, cz, Infinity);
        this._meshChunk(this._chunkArr[cz * NX + cx], ALL_SECTIONS);
        if (performance.now() - last > 35) {
          progress(k / list.length, `Building the city... ${Math.round((k / list.length) * 100)}%`);
          await new Promise((r) => setTimeout(r, 0));
          last = performance.now();
        }
      }
    } finally {
      this._initing = false;
      this.ready = true;
    }
    progress(1, 'World ready');
  }

  _makeMaterials() {
    const map = this.textures.atlasTexture;
    // Opaque pass: solid + alpha-tested cutout (leaves, plants) + emissive blocks (lit windows, lamps, neon). Emissive
    // faces are flagged in the light attribute and get a night glow masked per pixel by the atlas alpha
    // (255 = glows, 240 = frame/housing that stays dark); brightness follows sky.nightFactor.
    const opaque = new THREE.MeshLambertMaterial({ map, vertexColors: true, alphaTest: 0.5 });
    opaque.name = 'world.opaque';
    const transparent = new THREE.MeshLambertMaterial({ map, vertexColors: true, transparent: true, depthWrite: false, opacity: 0.8 });
    transparent.name = 'world.transparent';
    this._patchMaterial(opaque, 'opaque', true);
    this._patchMaterial(transparent, 'transparent', false);
    /** materials.emissive is the opaque material (emissive blocks are drawn in the opaque mesh). */
    this.materials = { opaque, transparent, emissive: opaque };
  }

  /**
   * Shader injection shared by the chunk materials: the `blockLight` vertex attribute carries lamp/neon light (rgb,
   * added at night) and sky exposure (a: covered spaces get darker), and the emissive pass gets its glow term.
   */
  _patchMaterial(mat, pass, glowMask) {
    const u = this._uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLamp = u.uLamp;
      shader.uniforms.uCovered = u.uCovered;
      shader.uniforms.uGlow = u.uGlow;
      shader.vertexShader = shader.vertexShader
        .replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute vec4 blockLight;\nvarying vec4 vBlockLight;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n\tvBlockLight = blockLight;');
      const glow = glowMask ? [
        '\tfloat glowMask = step( 0.998, vBlockLight.a ) * clamp( ( diffuseColor.a - 0.94 ) * 16.6667, 0.0, 1.0 );',
        '\ttotalEmissiveRadiance += diffuseColor.rgb * glowMask * uGlow;',
      ].join('\n') : '';
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform float opacity;', 'uniform float opacity;\nuniform float uLamp;\nuniform float uCovered;\nuniform float uGlow;\nvarying vec4 vBlockLight;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + glow)
        .replace('#include <aomap_fragment>', [
          '#include <aomap_fragment>',
          '\tfloat skyF = mix( uCovered, 1.0, min( vBlockLight.a * 1.004, 1.0 ) );',
          '\treflectedLight.directDiffuse *= skyF;',
          '\treflectedLight.indirectDiffuse *= skyF;',
          '\ttotalEmissiveRadiance += diffuseColor.rgb * vBlockLight.rgb * uLamp;',
        ].join('\n'));
    };
    mat.customProgramCacheKey = () => 'blockcity-world-' + pass + '-v3';
  }

  _applySettings(s, initial) {
    const rd = clamp(Math.round(+s.renderDistance || 6), 2, 16);
    if (rd !== this.renderDistance || initial || this._offX.length === 0) {
      this.renderDistance = rd;
      this._buildOffsets();
      this._cursor = 0;
    }
    const sh = !!s.shadows;
    if (sh !== this.shadows || initial) {
      this.shadows = sh;
      for (const ch of this.chunks.values()) for (const m of ch.meshes) this._shadowFlags(m);
      if (this.materials) for (const k of PASSES) this.materials[k].needsUpdate = true;
    }
  }

  _shadowFlags(mesh) {
    const pass = mesh.userData.pass;
    mesh.castShadow = this.shadows && pass === 'opaque';
    mesh.receiveShadow = this.shadows;
  }

  /** Chunk offsets inside the load circle, nearest first. */
  _buildOffsets() {
    const R = this.renderDistance;
    const list = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= R * R + R) list.push([dx, dz, Math.sqrt(d2)]);
      }
    }
    list.sort((a, b) => a[2] - b[2] || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    this._offX = Int16Array.from(list, (o) => o[0]);
    this._offZ = Int16Array.from(list, (o) => o[1]);
    this._offD = Float32Array.from(list, (o) => o[2]);
  }

  // ============================================================================================ per frame

  update(dt) {
    if (!this.materials || this._initing) return;
    this._frame++;
    this._work = 0;
    this._updateEmissive();
    try { this.textures.update(dt, this.game.renderer); } catch (e) { /* animation is cosmetic */ }
    this._flushUrgent(URGENT_BUDGET_MS);
    this._stream();
    if (this._frame % 30 === 0) this._unloadFar();
  }

  /** Edits made by systems updating after the world (player mining) are remeshed before this frame renders. */
  lateUpdate() {
    if (!this.materials || this._initing || this._urgent.size === 0) return;
    this._flushUrgent(URGENT_BUDGET_MS);
  }

  _centre() {
    const g = this.game;
    if (g.state === 'playing' && g.player && g.player.position) return g.player.position;
    const cam = g.camera && g.camera.position;
    if (cam && (cam.x !== 0 || cam.y !== 0 || cam.z !== 0)) return cam;
    const sp = g.generator && g.generator.plan && g.generator.plan.spawn;
    return sp || { x: WORLD.SIZE_X / 2, y: WORLD.CITY_LEVEL, z: WORLD.SIZE_Z / 2 };
  }

  /**
   * Load order: nearest first, biased toward the camera's view direction (chunks ahead load before chunks behind
   * at a similar distance, which matters when driving fast). Recomputed when the centre chunk or heading changes.
   */
  _sortOrder(yaw) {
    const n = this._offX.length;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    if (!this._order || this._order.length !== n) { this._order = new Array(n); this._score = new Float32Array(n); }
    for (let k = 0; k < n; k++) {
      const d = this._offD[k];
      this._order[k] = k;
      if (d <= FORCE_RADIUS) { this._score[k] = d - 100; continue; }
      const dot = (this._offX[k] * fx + this._offZ[k] * fz) / d;
      this._score[k] = d * (1 - FORWARD_BIAS * dot);
    }
    const sc = this._score;
    this._order.sort((a, b) => sc[a] - sc[b]);
    this._orderYaw = yaw;
  }

  _stream() {
    const c = this._centre();
    const ccx = clamp(Math.floor(c.x / C), 0, NX - 1), ccz = clamp(Math.floor(c.z / C), 0, NZ - 1);
    let yaw = this._orderYaw;
    const cam = this.game.camera;
    if (cam) { cam.getWorldDirection(_fwd); if (_fwd.x * _fwd.x + _fwd.z * _fwd.z > 1e-6) yaw = Math.atan2(_fwd.x, _fwd.z); }
    let dy = Math.abs(yaw - this._orderYaw) % (Math.PI * 2);
    if (dy > Math.PI) dy = Math.PI * 2 - dy;
    if (ccx !== this._ccx || ccz !== this._ccz || !this._order || this._order.length !== this._offX.length || dy > 0.6) {
      this._ccx = ccx; this._ccz = ccz; this._cursor = 0;
      this._sortOrder(yaw);
    }
    const end = performance.now() + STREAM_BUDGET_MS;
    const order = this._order;
    const n = order.length;
    for (let i = this._cursor; i < n; i++) {
      const k = order[i];
      const cx = ccx + this._offX[k], cz = ccz + this._offZ[k];
      const inside = cx >= 0 && cz >= 0 && cx < NX && cz < NZ;
      const ch = inside ? this._chunkArr[cz * NX + cx] : null;
      if (!inside || (ch && ch.meshed && !ch.dirty)) {
        if (i === this._cursor) this._cursor++;
        continue;
      }
      // the 3x3 chunks around the centre always load at once (teleports / respawns never show a void)
      const forced = this._offD[k] <= FORCE_RADIUS;
      if (!forced && this._work > 0 && performance.now() > end) break;
      if (!this._ensureNeighbourData(cx, cz, forced ? Infinity : end)) break; // budget ran out while generating
      const chunk = this._chunkArr[cz * NX + cx];
      this._meshChunk(chunk, chunk.meshed ? chunk.mask : ALL_SECTIONS);
      this._work++;
    }
  }

  _flushUrgent(budgetMs) {
    if (this._urgent.size === 0) return;
    const end = performance.now() + budgetMs;
    let n = 0;
    for (const ch of this._urgent) {
      if (n > 0 && performance.now() > end) break;
      this._urgent.delete(ch);
      ch.urgent = false;
      if (ch.meshed && ch.dirty) { this._meshChunk(ch, ch.mask); n++; }
    }
  }

  _unloadFar() {
    const lim = this.renderDistance + 2;
    const lim2 = lim * lim;
    const keep2 = (KEEP_PARTS_R + 1) * (KEEP_PARTS_R + 1);
    for (const ch of this.chunks.values()) {
      if (!ch.meshed) continue;
      const dx = ch.cx - this._ccx, dz = ch.cz - this._ccz;
      const d2 = dx * dx + dz * dz;
      if (d2 > lim2) this._unloadMeshes(ch);
      else if (ch.parts && d2 > keep2 && !ch.dirty) ch.parts = null;
    }
  }

  _updateEmissive() {
    const sky = this.game.sky;
    const nf = clamp(sky && typeof sky.nightFactor === 'number' ? sky.nightFactor : 0, 0, 1);
    const t = nf * nf * (3 - 2 * nf);
    // dark rainy days light the windows a little too
    const dim = sky && typeof sky.lightLevel === 'number' ? clamp(1 - sky.lightLevel, 0, 1) * 0.35 : 0;
    this._uniforms.uGlow.value = Math.max(DAY_GLOW + (NIGHT_GLOW - DAY_GLOW) * t, dim);
    this._uniforms.uLamp.value = Math.max(NIGHT_LAMP * t, dim * 2);
  }

  // ============================================================================================ chunk data

  /** Voxel data of chunk (cx,cz), generated synchronously if needed. null outside the world. */
  getChunkData(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) return null;
    return this._datas[cz * NX + cx] || this._ensureData(cx, cz);
  }

  /** Chunk record {key, cx, cz, data, meshes, dirty, meshed} (data generated if needed). null outside. */
  getChunk(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) return null;
    if (!this._datas[cz * NX + cx]) this._ensureData(cx, cz);
    return this._chunkArr[cz * NX + cx];
  }

  _ensureData(cx, cz) {
    const ci = cz * NX + cx;
    let d = this._datas[ci];
    if (d) return d;
    d = this._generate(cx, cz);
    const pend = this._pending.get(ci);
    if (pend) {
      for (const [vi, id] of pend) d[vi] = id;
      this._pending.delete(ci);
    }
    this._datas[ci] = d;
    const key = cx + ',' + cz;
    const ch = {
      key, cx, cz, index: ci, data: d, meshes: [], dirty: false, meshed: false,
      mask: 0, urgent: false, parts: null, mesh: { opaque: null, transparent: null },
      height: null, lights: null,
    };
    this._chunkArr[ci] = ch;
    this.chunks.set(key, ch);
    return d;
  }

  _generate(cx, cz) {
    const gen = this.game && this.game.generator;
    let d = null;
    const t0 = performance.now();
    if (gen && typeof gen.generateChunk === 'function') {
      try { d = gen.generateChunk(cx, cz); } catch (e) {
        if (!this._genErrorLogged) { this._genErrorLogged = true; console.error('[world] generator.generateChunk failed, using flat fallback', e); }
        d = null;
      }
    }
    if (d && d.length === CHUNK_LEN) {
      if (!(d instanceof Uint8Array)) d = Uint8Array.from(d);
      else if (d === this._lastGen) d = d.slice(); // generator reuses its buffer: keep our own copy
      this._lastGen = d;
    } else {
      d = fallbackChunk();
    }
    const ms = performance.now() - t0;
    const s = this._stats;
    s.genCount++; s.genMs += ms; if (ms > s.genMax) s.genMax = ms;
    return d;
  }

  /** Make sure chunk (cx,cz) and its 8 neighbours have data. Returns false if `deadline` passed before finishing. */
  _ensureNeighbourData(cx, cz, deadline) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= NX || z >= NZ || this._datas[z * NX + x]) continue;
        if (this._work > 0 && performance.now() > deadline) return false;
        this._ensureData(x, z);
        this._work++;
      }
    }
    return true;
  }

  // ============================================================================================ meshing

  _meshChunk(ch, mask) {
    if (!ch || !this._tables) return;
    const t0 = performance.now();
    const full = !ch.parts;
    if (full) { ch.parts = new Array(SECTIONS).fill(null); mask = ALL_SECTIONS; }
    const getData = (x, z) => this.getChunkData(x, z);
    const wx0 = ch.cx * C, wz0 = ch.cz * C;
    const env = prepareEnv(this._env, this._getHeights, this._getLights, ch.cx, ch.cz, this._tables);
    const changed = { opaque: false, transparent: false };
    for (let s = 0; s < SECTIONS; s++) {
      if (!(mask & (1 << s))) continue;
      fillPad(this._pad, getData, ch.cx, ch.cz, s * SECTION_H, (s + 1) * SECTION_H);
      const res = meshSection(this._pad, s, this._tables, wx0, wz0, env);
      const old = ch.parts[s];
      for (const p of PASSES) if (res[p] || (old && old[p])) changed[p] = true;
      ch.parts[s] = (res.opaque || res.transparent) ? { opaque: res.opaque, transparent: res.transparent } : null;
      this._stats.sectionCount++;
    }
    for (const p of PASSES) if (changed[p] || full || !ch.meshed) this._applyPass(ch, p);
    ch.meshes = PASSES.map((p) => ch.mesh[p]).filter(Boolean);
    ch.meshed = true;
    ch.dirty = false;
    ch.mask = 0;
    // per-section CPU data is only worth keeping where edits happen (near the player); elsewhere a rare edit remeshes
    // the whole chunk. This keeps memory flat at large render distances.
    const dx = ch.cx - this._ccx, dz = ch.cz - this._ccz;
    if (dx * dx + dz * dz > KEEP_PARTS_R * KEEP_PARTS_R) ch.parts = null;
    const ms = performance.now() - t0;
    const st = this._stats;
    st.meshCount++; st.meshMs += ms; st.lastMeshMs = ms; if (ms > st.meshMax) st.meshMax = ms;
  }

  _applyPass(ch, pass) {
    const merged = mergeParts(ch.parts.map((p) => (p ? p[pass] : null)));
    let mesh = ch.mesh[pass];
    if (!merged) {
      if (mesh) { this.group.remove(mesh); mesh.geometry.dispose(); ch.mesh[pass] = null; }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(merged.position, 3).onUpload(disposeArray));
    geo.setAttribute('normal', new THREE.BufferAttribute(merged.normal, 4, true).onUpload(disposeArray));
    geo.setAttribute('color', new THREE.BufferAttribute(merged.color, 4, true).onUpload(disposeArray));
    geo.setAttribute('uv', new THREE.BufferAttribute(merged.uv, 2).onUpload(disposeArray));
    geo.setAttribute('blockLight', new THREE.BufferAttribute(merged.light, 4, true).onUpload(disposeArray));
    geo.setIndex(new THREE.BufferAttribute(merged.index, 1).onUpload(disposeArray));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, merged.minY, 0), new THREE.Vector3(C, merged.maxY, C));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    geo.userData.quads = merged.quads;
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, this.materials[pass]);
      mesh.name = `chunk:${ch.key}:${pass}`;
      mesh.userData.pass = pass;
      mesh.userData.chunk = ch.key;
      mesh.matrixAutoUpdate = false;
      mesh.position.set(ch.cx * C, 0, ch.cz * C);
      mesh.updateMatrix();
      mesh.raycast = noRaycast; // use world.raycast (voxel DDA); triangle raycasts over chunks would be very slow
      this._shadowFlags(mesh);
      this.group.add(mesh);
      ch.mesh[pass] = mesh;
    }
  }

  _unloadMeshes(ch) {
    for (const p of PASSES) {
      const m = ch.mesh[p];
      if (m) { this.group.remove(m); m.geometry.dispose(); ch.mesh[p] = null; }
    }
    ch.meshes = [];
    ch.parts = null;
    ch.meshed = false;
    ch.dirty = false;
    ch.mask = 0;
    if (ch.urgent) { this._urgent.delete(ch); ch.urgent = false; }
  }

  /** Mark the section(s) of chunk (cx,cz) touching row y for remesh. urgent = same-frame remesh. */
  _dirty(cx, cz, mask, urgent) {
    if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) return;
    const ch = this._chunkArr[cz * NX + cx];
    if (!ch || !ch.meshed) return; // not visible: it will be meshed fresh when it streams in
    ch.mask |= mask;
    ch.dirty = true;
    if (urgent) { if (!ch.urgent) { ch.urgent = true; this._urgent.add(ch); } }
    else this._cursor = 0;
  }

  /** Dirty everything a change at (x,y,z) can affect (own chunk + touching neighbours, AO included). */
  _touch(x, y, z, urgent) {
    const s = y >> 4;
    let mask = 1 << s;
    const ly = y & 15;
    if (ly === 0 && s > 0) mask |= 1 << (s - 1);
    if (ly === 15 && s < SECTIONS - 1) mask |= 1 << (s + 1);
    const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
    const ex = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const ez = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    this._dirty(cx, cz, mask, urgent);
    if (ex) this._dirty(cx + ex, cz, mask, urgent);
    if (ez) this._dirty(cx, cz + ez, mask, urgent);
    if (ex && ez) this._dirty(cx + ex, cz + ez, mask, urgent);
  }

  // ============================================================================================ block API

  /** Block id at integer coords. y<0 -> BEDROCK, y>=96 or outside x/z -> AIR. Generates missing chunks synchronously. */
  getBlock(x, y, z) {
    if (y < 0) return 1;
    if (y >= H || x < 0 || z < 0 || x >= WORLD.SIZE_X || z >= WORLD.SIZE_Z) return 0;
    const ci = (z >> 4) * NX + (x >> 4);
    const d = this._datas[ci] || this._ensureData(x >> 4, z >> 4);
    return d[(x & 15) | ((z & 15) << 4) | ((y | 0) << 8)];
  }

  /** Solid (collidable) block? Outside x/z -> true (invisible wall), y<0 -> true, y>=96 -> false. */
  isSolid(x, y, z) {
    if (y < 0) return true;
    if (y >= H) return false;
    if (x < 0 || z < 0 || x >= WORLD.SIZE_X || z >= WORLD.SIZE_Z) return true;
    const ci = (z >> 4) * NX + (x >> 4);
    const d = this._datas[ci] || this._ensureData(x >> 4, z >> 4);
    return SOLID[d[(x & 15) | ((z & 15) << 4) | ((y | 0) << 8)]] === 1;
  }

  /** Liquid (water) at the block? */
  isLiquid(x, y, z) { return LIQUID[this.getBlock(x, y, z)] === 1; }

  /** Opaque full cube at the block? (hides faces, blocks light) */
  isOpaque(x, y, z) { return OPAQUE[this.getBlock(x, y, z)] === 1; }

  /** Block definition at the block (BLOCKS entry). */
  getBlockDef(x, y, z) { return BLOCKS[this.getBlock(x, y, z)] || BLOCKS[0]; }

  /**
   * Set a block. Marks the chunk (and touching neighbours) for a same-frame remesh. Records into `edits` unless
   * record:false. Returns true if the block changed.
   */
  setBlock(x, y, z, id, { record = true } = {}) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (!(y >= 0 && y < H && x >= 0 && z >= 0 && x < WORLD.SIZE_X && z < WORLD.SIZE_Z)) return false;
    id = id | 0;
    if (id < 0 || id > 255 || !BLOCKS[id]) return false;
    return this._set(x, y, z, id, record);
  }

  _set(x, y, z, id, record, urgent = true) {
    const cx = x >> 4, cz = z >> 4;
    const d = this._datas[cz * NX + cx] || this._ensureData(cx, cz);
    const vi = (x & 15) | ((z & 15) << 4) | (y << 8);
    const old = d[vi];
    if (old === id) return false;
    d[vi] = id;
    if (record) this.edits.set(x + ',' + y + ',' + z, id);
    this._touch(x, y, z, urgent);
    const ch = this._chunkArr[cz * NX + cx];
    // sky exposure: the column height may change -> faces within the exposure kernel between old/new height
    if (ch.height && OPAQUE[old] !== OPAQUE[id]) {
      const col = (x & 15) | ((z & 15) << 4);
      const h0 = ch.height[col];
      let h1 = h0;
      if (OPAQUE[id] && y + 1 > h0) h1 = y + 1;
      else if (!OPAQUE[id] && y + 1 === h0) {
        h1 = 0;
        for (let yy = y - 1; yy >= 0; yy--) if (OPAQUE[d[col | (yy << 8)]]) { h1 = yy + 1; break; }
      }
      if (h1 !== h0) {
        ch.height[col] = h1;
        const r = SKY_K + 1;
        this._dirtyBox(x - r, x + r, z - r, z + r, Math.min(h0, h1) - 1, Math.max(h0, h1), urgent);
      }
    }
    // block light sources
    if (LIGHTSRC[old] || LIGHTSRC[id]) {
      if (ch.lights) {
        const lx = x & 15, lz = z & 15;
        const k = ch.lights.findIndex((e) => e[0] === lx && e[1] === y && e[2] === lz);
        if (k >= 0) ch.lights.splice(k, 1);
        if (LIGHTSRC[id]) ch.lights.push([lx, y, lz, id]);
      }
      const R = MAX_LIGHT_R + 1;
      this._dirtyBox(x - R, x + R, z - R, z + R, y - R, y + R, urgent);
    }
    return true;
  }

  /** Dirty every meshed chunk section intersecting the world box (inclusive bounds). */
  _dirtyBox(x0, x1, z0, z1, y0, y1, urgent) {
    const s0 = clamp(Math.floor(y0 / SECTION_H), 0, SECTIONS - 1), s1 = clamp(Math.floor(y1 / SECTION_H), 0, SECTIONS - 1);
    let mask = 0;
    for (let k = s0; k <= s1; k++) mask |= 1 << k;
    for (let cz = Math.max(0, z0 >> 4); cz <= Math.min(NZ - 1, z1 >> 4); cz++) {
      for (let cx = Math.max(0, x0 >> 4); cx <= Math.min(NX - 1, x1 >> 4); cx++) this._dirty(cx, cz, mask, urgent);
    }
  }

  /** Voxel raycast (see core/physics voxelRaycast): {x,y,z,id,normal,point,distance} | null. */
  raycast(origin, dir, maxDist, opts) { return voxelRaycast(this, origin, dir, maxDist, opts); }

  /** Standing height (top of the first solid block scanning down from startY), or -1. */
  findGround(x, z, startY = H - 1) { return physFindGround(this, x, z, startY); }

  /** Highest non-air block y in a column (-1 if empty). */
  columnTop(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    for (let y = H - 1; y >= 0; y--) if (this.getBlock(x, y, z) !== 0) return y;
    return -1;
  }

  /**
   * Remove blocks inside a sphere (slightly noisy edge) whose blast resistance <= power. Never removes bedrock or
   * water. Unsupported plants above the crater go too. Returns [{x,y,z,id}] (combat primes TNT from this list).
   * Edits are recorded; the affected chunks are remeshed in one batch this frame.
   */
  explode(center, radius, power = 4) {
    const removed = [];
    if (!center || !(radius > 0)) return removed;
    const cx = center.x, cy = center.y, cz = center.z;
    const r = Math.min(radius, 24);
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(WORLD.SIZE_X - 1, Math.floor(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(H - 1, Math.floor(cy + r + 1));
    const z0 = Math.max(0, Math.floor(cz - r - 1)), z1 = Math.min(WORLD.SIZE_Z - 1, Math.floor(cz + r + 1));
    const edge = Math.min(1.1, 0.25 + r * 0.2);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
          const lim = r + (Math.random() - 0.5) * edge;
          if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
          const id = this.getBlock(x, y, z);
          if (id === 0 || id === B.BEDROCK || LIQUID[id]) continue;
          if (BLAST[id] > power) continue;
          if (this._set(x, y, z, 0, true)) removed.push({ x, y, z, id });
        }
      }
    }
    const n = removed.length;
    for (let i = 0; i < n; i++) {
      const b = removed[i];
      if (b.y + 1 >= H) continue;
      const up = this.getBlock(b.x, b.y + 1, b.z);
      if (CROSS[up] && this._set(b.x, b.y + 1, b.z, 0, true)) removed.push({ x: b.x, y: b.y + 1, z: b.z, id: up });
    }
    return removed;
  }

  /**
   * Apply saved edits. Accepts a Map/obj of 'x,y,z' -> id, an array of [key, id] / {x,y,z,id}, or a flat number
   * array [x,y,z,id, ...]. Chunks not generated yet receive them when they are generated.
   */
  applyEdits(map) {
    if (!map) return 0;
    let n = 0;
    const one = (x, y, z, id) => {
      x = Math.floor(+x); y = Math.floor(+y); z = Math.floor(+z); id = id | 0;
      if (!(y >= 0 && y < H && x >= 0 && z >= 0 && x < WORLD.SIZE_X && z < WORLD.SIZE_Z) || !BLOCKS[id]) return;
      this.edits.set(x + ',' + y + ',' + z, id);
      const ci = (z >> 4) * NX + (x >> 4);
      const vi = (x & 15) | ((z & 15) << 4) | (y << 8);
      const d = this._datas[ci];
      if (d) {
        this._set(x, y, z, id, false, false);
      } else {
        let p = this._pending.get(ci);
        if (!p) { p = []; this._pending.set(ci, p); }
        p.push([vi, id]);
      }
      n++;
    };
    const fromKey = (k, id) => { const p = String(k).split(','); if (p.length === 3) one(p[0], p[1], p[2], id); };
    if (map instanceof Map) {
      for (const [k, id] of map) fromKey(k, id);
    } else if (Array.isArray(map)) {
      if (map.length && typeof map[0] === 'number') {
        for (let i = 0; i + 3 < map.length; i += 4) one(map[i], map[i + 1], map[i + 2], map[i + 3]);
      } else {
        for (const e of map) {
          if (Array.isArray(e)) { if (e.length === 2) fromKey(e[0], e[1]); else if (e.length >= 4) one(e[0], e[1], e[2], e[3]); }
          else if (e && typeof e === 'object') one(e.x, e.y, e.z, e.id);
        }
      }
    } else if (typeof map === 'object') {
      for (const k of Object.keys(map)) fromKey(k, map[k]);
    }
    return n;
  }

  /** Compact edits for saving: flat [x,y,z,id, ...] (applyEdits accepts it back). */
  serializeEdits(limit = 50000) {
    const out = [];
    for (const [k, id] of this.edits) {
      if (out.length / 4 >= limit) break;
      const p = k.split(',');
      out.push(+p[0], +p[1], +p[2], id);
    }
    return out;
  }

  /** True if the chunk containing world (x,z) currently has its meshes built. */
  isMeshedAt(x, z) {
    const cx = Math.floor(x / C), cz = Math.floor(z / C);
    if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) return false;
    const ch = this._chunkArr[cz * NX + cx];
    return !!(ch && ch.meshed);
  }

  // ============================================================================================ debug

  /** Synchronously remesh every meshed chunk. Returns {chunks, ms}. */
  remeshAll() {
    const t0 = performance.now();
    let n = 0;
    for (const ch of this.chunks.values()) {
      if (!ch.meshed) continue;
      this._meshChunk(ch, ALL_SECTIONS);
      n++;
    }
    return { chunks: n, ms: +(performance.now() - t0).toFixed(1) };
  }

  stats() {
    let meshed = 0, meshes = 0, quads = 0, dirty = 0;
    for (const ch of this.chunks.values()) {
      if (ch.meshed) meshed++;
      if (ch.dirty) dirty++;
      for (const m of ch.meshes) { meshes++; quads += m.geometry.userData.quads || 0; }
    }
    let toLoad = 0;
    for (let k = 0; k < this._offX.length; k++) {
      const cx = this._ccx + this._offX[k], cz = this._ccz + this._offZ[k];
      if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) continue;
      const ch = this._chunkArr[cz * NX + cx];
      if (!ch || !ch.meshed) toLoad++;
    }
    const s = this._stats;
    return {
      ready: this.ready,
      renderDistance: this.renderDistance,
      centre: [this._ccx, this._ccz],
      chunksWithData: this.chunks.size,
      chunksMeshed: meshed,
      toLoad,
      dirty,
      urgent: this._urgent.size,
      meshes,
      quads,
      triangles: quads * 2,
      edits: this.edits.size,
      pendingEditChunks: this._pending.size,
      genCount: s.genCount,
      avgGenMs: s.genCount ? +(s.genMs / s.genCount).toFixed(2) : 0,
      maxGenMs: +s.genMax.toFixed(2),
      meshCount: s.meshCount,
      avgMeshMs: s.meshCount ? +(s.meshMs / s.meshCount).toFixed(2) : 0,
      maxMeshMs: +s.meshMax.toFixed(2),
      lastMeshMs: +s.lastMeshMs.toFixed(2),
      glow: +this._uniforms.uGlow.value.toFixed(3),
      lamp: +this._uniforms.uLamp.value.toFixed(3),
    };
  }

  _installDebug() {
    const dbg = this.game.debug;
    if (!dbg) return;
    dbg.remeshAll = () => this.remeshAll();
    dbg.worldStats = () => this.stats();
    /** Data URL of the block atlas (level 0, upright), optionally scaled. */
    dbg.blockIds = () => ({ ...B });
    dbg.atlasURL = (scale = 2) => { const c = this.textures.toCanvas(scale); return c ? c.toDataURL() : null; };
    /** Fill a box with a block id (debug building). */
    dbg.fillBlocks = (x0, y0, z0, x1, y1, z1, id) => {
      let n = 0;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (this.setBlock(x, y, z, id, { record: false })) n++;
        }
      }
      return n;
    };
  }

  dispose() {
    for (const u of this._unsub) { try { u && u(); } catch (e) { /* ignore */ } }
    this._unsub = [];
    for (const ch of this.chunks.values()) this._unloadMeshes(ch);
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.materials) for (const k of PASSES) this.materials[k].dispose();
    this.textures.dispose();
  }
}
