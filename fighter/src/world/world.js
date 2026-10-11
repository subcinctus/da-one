// World system (FIGHTER.md §10): chapter environments, walkable space, gates, sun + sky.
//
//   loadChapter(id)          -> layout { chapterId, playerStart, rooms, bounds } (sync; awaitable). Disposes the
//                               previous chapter. Re-loading the loaded chapter just resets its gates.
//   clampPosition(pos, r)    keep a position inside room floors / corridors (closed gates block). Returns pos.
//   isWalkable(x, z, r?)     roomAt(pos | x, z)     setGate(roomId, open, instant?)
//   gateOpen(roomId)         getRoom(id | index)    currentRoom (room the player stands in, or null)
//   cameraClip / ceilingAt   used by the camera rig.      emits 'worldLoaded' { chapterId, layout }
// Room extras: name, shape, halfX/halfZ, rect, bossSpot, gates[]; room.gate = ENTRY gate, room.exitGate +
// room.exit (point in front of it) for fight rooms. Entry gates start open, exit gates closed.
// setGate(room, false) closes both of a room's gates; setGate(room, true) opens both.
// Look: merged vertex-coloured meshes per room (+ baked light glow), one shadowed sun fitted to the active room,
// a hemisphere light, an optional non-shadow fill (chapter light `fill: { color, intensity, dir }`) and a gradient
// sky dome. No fog, no particles, no post.
import * as THREE from 'three';
import { buildLayout, CHAPTER_IDS } from './layout.js';
import { Walkable } from './walk.js';
import { MeshBuilder, makeMaterials } from './geo.js';
import { createSky } from './sky.js';
import { GateView } from './gates.js';
import { STYLES } from './chapters/index.js';
import { makeRng } from '../core/math.js';

const SHADOW_SIZE = 2048;

export class World {
  constructor(game) {
    this.game = game;
    this.runWhenPaused = true;
    this.layout = null;
    this.walk = null;
    this.chapterId = null;
    this.group = null;
    this.gateViews = [];
    this.focusArea = null;
    this.currentRoom = null;
    this.stats = { meshes: 0, triangles: 0, buildMs: 0 };
    this._markers = null;
    this._sunDir = new THREE.Vector3(0.5, 0.6, -0.3).normalize();
    this._v = new THREE.Vector3();
    this._fit = { ax: new THREE.Vector3(), ay: new THREE.Vector3(), az: new THREE.Vector3(), eye: new THREE.Vector3() };
  }

  init() {
    const g = this.game;
    this.mats = makeMaterials();
    g.scene.background = new THREE.Color(0xd9e4ea);

    this.sky = createSky();
    g.scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1.2);
    g.scene.add(this.hemi);

    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 3));
    sun.castShadow = g.settings.shadows !== false;
    sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 3;
    const cam = sun.shadow.camera;
    cam.near = 1; cam.far = 120; cam.left = -10; cam.right = 10; cam.top = 10; cam.bottom = -10;
    g.scene.add(sun);
    g.scene.add(sun.target);

    // Fill: one cheap non-shadow directional light, always present so shader programs stay the same across chapters
    // (intensity 0 unless the chapter's light table has `fill`). Its target stays at the origin; only the direction
    // matters. Lights the fighters where a chapter's light is otherwise only baked into the walls (night market).
    const fill = (this.fill = new THREE.DirectionalLight(0xffffff, 0));
    fill.castShadow = false;
    fill.position.set(0, 1, 0);
    g.scene.add(fill);

    g.events?.on?.('settingsChanged', (s) => { if (this.sun) this.sun.castShadow = s?.shadows !== false; });

    this._installDebug();

    // Always have an environment behind the title screen.
    const first = g.params?.get?.('chapter');
    this.loadChapter(CHAPTER_IDS.includes(first) ? first : 'laundromat');
  }

  // ------------------------------------------------------------------ chapter build

  /** Build (or reset) a chapter. Returns the layout synchronously (also fine to await). */
  loadChapter(id) {
    if (!STYLES[id]) id = 'laundromat';
    if (this.chapterId === id && this.layout) {
      this._resetGates();
      this.game.events?.emit?.('worldLoaded', { chapterId: id, layout: this.layout });
      return this.layout;
    }
    const t0 = performance.now();
    this._dispose();
    const style = STYLES[id];
    const layout = buildLayout(id);
    this.layout = layout;
    this.chapterId = id;
    this.walk = new Walkable(layout);
    this.style = style;

    const group = (this.group = new THREE.Group());
    group.name = 'world:' + id;

    // builders: one set per room / start area; corridors merge into the room they lead to.
    const sets = new Map();
    // m: matte (casts + receives), g: gloss, gl: glass, nc: matte that casts no shadow (hanging decor, wires)
    const mk = () => ({ m: new MeshBuilder(), g: new MeshBuilder(), gl: new MeshBuilder(), nc: new MeshBuilder() });
    for (const a of layout.areas) if (a.kind !== 'corridor') sets.set(a, mk());
    const ext = mk();
    const ctx = {
      layout, walk: this.walk, lights: [], rng: makeRng(hash(id)), ext,
      B: (a) => sets.get(a.kind === 'corridor' ? a.to : a) || ext,
      style,
    };
    try { style.build(ctx); } catch (e) { console.error('[world] build ' + id, e); }

    // bake point lights, convert to meshes
    let meshes = 0, tris = 0;
    const toMeshes = (set, name) => {
      for (const k of ['m', 'g', 'gl', 'nc']) {
        const b = set[k];
        if (b.empty) continue;
        b.lift = style.bakeLift ?? 0;
        if (k === 'm' || k === 'g') b.bake(ctx.lights);
        const mesh = new THREE.Mesh(b.build(), k === 'g' ? this.mats.gloss : k === 'gl' ? this.mats.glass : this.mats.matte);
        mesh.name = name + ':' + k;
        mesh.castShadow = k === 'm';
        mesh.receiveShadow = k !== 'gl';
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        meshes++; tris += b.idx.length / 3;
      }
    };
    for (const [a, set] of sets) toMeshes(set, a.kind === 'start' ? 'start' : a.room.id);
    toMeshes(ext, 'ext');

    // gates
    this.gateViews = [];
    for (const gate of layout.gates) {
      let desc = null;
      try { desc = style.gate(gate, ctx); } catch (e) { console.error('[world] gate', e); }
      if (!desc) continue;
      const near = ctx.lights.filter((L) => Math.hypot(L.x - gate.x, L.z - gate.z) < L.range + 4);
      for (const l of desc.leaves || []) {
        const p = l.pivot || [0, 0, 0];
        if (near.length) l.builder?.bake?.(near.map((L) => ({ ...L, x: L.x - gate.x - p[0], y: L.y - p[1], z: L.z - gate.z - p[2] })));
      }
      const gv = new GateView(gate, desc, this.mats);
      group.add(gv.group);
      this.gateViews.push(gv);
      meshes += gv.leaves.length;
    }
    this.game.scene.add(group);
    this._applyLighting(style.light);
    this.stats = { meshes, triangles: Math.round(tris), buildMs: Math.round(performance.now() - t0), lights: ctx.lights.length };
    this.focusArea = null;
    this.currentRoom = null;
    this._fitShadow(layout.areas[0]);
    this.game.events?.emit?.('worldLoaded', { chapterId: id, layout });
    return layout;
  }

  _applyLighting(L) {
    if (!L) return;
    const g = this.game;
    this._sunDir.set(L.sunDir[0], L.sunDir[1], L.sunDir[2]).normalize();
    this.sun.color.set(L.sun);
    this.sun.intensity = L.sunI;
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround);
    this.hemi.intensity = L.hemiI;
    const F = L.fill;
    if (F && this.fill) {
      this.fill.color.set(F.color ?? 0xffffff);
      this.fill.intensity = F.intensity ?? 0.8;
      const d = F.dir || [0, 1, 0];
      this.fill.position.set(d[0], d[1], d[2]).normalize();
      this.fill.updateMatrixWorld();
    } else if (this.fill) this.fill.intensity = 0;
    this.sky.userData.apply(L.sky, this._sunDir);
    g.scene.background.set(L.sky.horizon);
    if (g.renderer) g.renderer.toneMappingExposure = L.exposure ?? 1;
  }

  _resetGates() {
    for (const gate of this.layout.gates) {
      gate.open = gate.role === 'entry';
      gate.t = gate.open ? 1 : 0;
      gate.blocking = !gate.open;
    }
    for (const gv of this.gateViews) gv.apply();
    this.walk.refresh();
    this.walk.memory = new WeakMap();
  }

  _dispose() {
    if (this.group) {
      this.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      this.group.removeFromParent();
    }
    this.group = null;
    this.gateViews = [];
  }

  // ------------------------------------------------------------------ walkable space API

  /** Keep a fighter position inside walkable space (modified in place). Returns pos. */
  clampPosition(pos, radius = 0.35) { return this.walk ? this.walk.clamp(pos, radius) : pos; }

  /** Is (x, z) inside walkable space, respecting closed gates? */
  isWalkable(x, z, radius = 0) {
    if (x && typeof x === 'object') { radius = typeof z === 'number' ? z : 0; z = x.z; x = x.x; }
    return this.walk ? this.walk.isWalkable(x, z, radius) : true;
  }

  /** The Room containing a position ({x, z} or x, z), or null in corridors / the start area. */
  roomAt(pos, z) {
    if (!this.walk) return null;
    if (pos && typeof pos === 'object') return this.walk.roomAt(pos.x, pos.z);
    return this.walk.roomAt(pos, z);
  }

  /** Room by id ('r0'..), index, or room object. */
  getRoom(id) {
    if (!this.layout) return null;
    if (id && typeof id === 'object') return this.layout.rooms.find((r) => r === id || r.id === id.id) || null;
    if (typeof id === 'number') return this.layout.rooms[id] || null;
    return this.layout.rooms.find((r) => r.id === id) || null;
  }

  /**
   * Open / close a room's gates (its entry and, for fight rooms, its exit) with a short animation.
   * Closing blocks immediately; opening unblocks once the gate is mostly open.
   */
  setGate(roomId, open, instant = false) {
    const room = this.getRoom(roomId);
    if (!room || !this.layout) return;
    let changed = false, gx = 0, gz = 0;
    for (const gate of this.layout.gates) {
      if (gate.roomId !== room.id) continue;
      if (gate.open !== !!open) { changed = true; gx = gate.x; gz = gate.z; }
      gate.open = !!open;
      if (instant) gate.t = open ? 1 : 0;
      if (!open) gate.blocking = true;
      else if (instant) gate.blocking = false;
    }
    for (const gv of this.gateViews) if (gv.gate.roomId === room.id) gv.apply();
    this.walk.refresh();
    if (changed && !instant) {
      try { this.game.audio?.play?.('gate', { position: { x: gx, y: 1, z: gz }, volume: 0.8 }); } catch (e) { /* audio optional */ }
    }
  }

  /** Is the room's gate open (its entry gate state)? */
  gateOpen(roomId) {
    const room = this.getRoom(roomId);
    if (!room || !this.layout) return false;
    const g = this.layout.gates.find((x) => x.roomId === room.id && x.role === (room.kind === 'boss' ? 'entry' : 'exit'));
    return !!(g && g.open);
  }

  /** Camera support: fraction of the pivot->camera segment inside camera space (see walk.js). */
  cameraClip(px, pz, cx, cz) { return this.walk ? this.walk.cameraClip(px, pz, cx, cz) : 1; }
  /** Ceiling height at (x, z); Infinity outdoors. */
  ceilingAt(x, z) { return this.walk ? this.walk.ceilingAt(x, z) : Infinity; }

  // ------------------------------------------------------------------ per frame

  update(dt) {
    const g = this.game;
    // gates animate in real time (they keep moving during dialogue / cinematics), frozen while paused
    if (!g.paused && this.gateViews.length) {
      let refresh = false;
      for (let i = 0; i < this.gateViews.length; i++) {
        const gv = this.gateViews[i];
        if (gv.step(Math.min(dt, 0.05))) {
          const gate = gv.gate;
          if (gate.open && gate.blocking && gate.t > 0.7) { gate.blocking = false; refresh = true; }
        } else if (gv.gate.open && gv.gate.blocking) { gv.gate.blocking = false; refresh = true; }
      }
      if (refresh) this.walk.refresh();
    }
    // sky follows the camera
    this.sky.position.copy(g.camera.position);

    // shadow camera follows the active area
    if (!this.walk) return;
    const p = g.player?.model?.root?.position || g.player?.position;
    let area;
    if (p && g.state === 'playing') area = this.walk.nearestArea(p.x, p.z);
    else area = this.walk.nearestArea(g.camera.position.x, g.camera.position.z);
    if (area !== this.focusArea) this._fitShadow(area);
    this.currentRoom = p ? this.walk.roomAt(p.x, p.z) : null;
  }

  /** Fit the sun's shadow camera tightly around an area (corridors include the room they lead to). */
  _fitShadow(area) {
    if (!area) return;
    this.focusArea = area;
    let minX, maxX, minZ, maxZ, h;
    const wallOf = (a) => a.wall;
    const add = (a) => {
      const w = wallOf(a);
      minX = Math.min(minX, w.minX); maxX = Math.max(maxX, w.maxX); minZ = Math.min(minZ, w.minZ); maxZ = Math.max(maxZ, w.maxZ);
      h = Math.max(h, isFinite(a.ceil) ? a.ceil : 4.5);
    };
    minX = minZ = Infinity; maxX = maxZ = -Infinity; h = 0;
    add(area);
    if (area.kind === 'corridor') { add(area.to); if (area.from) add(area.from); }
    else {
      // include the adjoining corridors so doorways don't pop
      if (area.corridorIn) add(area.corridorIn);
      if (area.corridorOut) add(area.corridorOut);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const F = this._fit, sd = this._sunDir;
    F.eye.set(cx + sd.x * 60, sd.y * 60, cz + sd.z * 60);
    this.sun.position.copy(F.eye);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    // light basis (matches Matrix4.lookAt: z = eye - target)
    F.az.copy(sd).normalize();
    F.ax.set(0, 1, 0).cross(F.az);
    if (F.ax.lengthSq() < 1e-6) F.ax.set(1, 0, 0);
    F.ax.normalize();
    F.ay.copy(F.az).cross(F.ax);
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, f = -Infinity;
    const v = this._v;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? maxX : minX, i & 2 ? h + 0.5 : -0.2, i & 4 ? maxZ : minZ).sub(F.eye);
      const x = v.dot(F.ax), y = v.dot(F.ay), z = -v.dot(F.az);
      l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); n = Math.min(n, z); f = Math.max(f, z);
    }
    const cam = this.sun.shadow.camera;
    const pad = 0.6;
    cam.left = l - pad; cam.right = r + pad; cam.bottom = b - pad; cam.top = t + pad;
    cam.near = Math.max(0.5, n - 30); cam.far = f + 2;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  // ------------------------------------------------------------------ debug

  _installDebug() {
    const g = this.game;
    const dbg = g.debug || (g.debug = {});
    const world = this;
    /** Jump to a chapter: full flow when available, else environment only (player moved to the start). */
    dbg.chapter = (id) => {
      if (typeof g.flow?.startChapter === 'function') return g.flow.startChapter(id);
      const L = world.loadChapter(id);
      const p = g.player;
      if (p?.position) { p.position.set(L.playerStart.x, 0, L.playerStart.z); p.yaw = L.playerStart.yaw; }
      g.cameraRig?.snap?.();
      return L;
    };
    /** Open / close every gate of the chapter. */
    dbg.gates = (open = true) => { for (const r of world.layout?.rooms || []) world.setGate(r.id, open, true); };
    /** Environment stats. */
    dbg.world = () => ({ chapter: world.chapterId, ...world.stats, focus: world.focusArea?.name, rooms: world.layout?.rooms?.map((r) => r.id + ':' + r.name) });
    /**
     * Test markers (capsules) for screenshots without combat: list of {x, z, color?, yaw?} or null to clear.
     */
    dbg.worldMarkers = (list) => {
      if (world._markers) { world._markers.removeFromParent(); world._markers.traverse((o) => o.geometry?.dispose?.()); world._markers = null; }
      if (!list || !list.length) return 0;
      const grp = new THREE.Group();
      const geo = new THREE.CapsuleGeometry(0.3, 1.1, 4, 10);
      const head = new THREE.SphereGeometry(0.17, 10, 8);
      for (const m of list) {
        const mat = new THREE.MeshStandardMaterial({ color: m.color ?? 0xf2f2f2, roughness: 0.8 });
        const body = new THREE.Mesh(geo, mat);
        body.position.set(m.x, 0.85, m.z); body.castShadow = true; body.receiveShadow = true;
        const hd = new THREE.Mesh(head, mat);
        hd.position.set(m.x, 1.68, m.z); hd.castShadow = true;
        grp.add(body, hd);
      }
      g.scene.add(grp);
      world._markers = grp;
      return list.length;
    };
  }
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
