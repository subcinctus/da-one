// Player interaction: block targeting (aim ray limited to reach), wireframe + face highlight, mining with crack
// overlay, block placing, pick-block, punching, weapon dispatch to Combat, grenade quick-throw and hand-lit TNT.
// Owned by Player (player.interact). See ARCHITECTURE.md §Player.
import * as THREE from 'three';
import { BLOCKS, B, breakTime } from '../world/blocks.js';
import { WORLD } from '../core/config.js';
import { voxelRaycast } from '../core/physics.js';
import { entityBox } from '../core/entities.js';
import { WEAPONS } from '../data/weapons.js';
import { toolOf, meleeDamage, isPlaceableBlock, isOreBlock } from '../data/items.js';
import { INTERACT } from './tuning.js';
import { blockCubeGeometry, blockColorGeometry } from './models.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _box = new THREE.Box3();
const _q = [];

const FACE_UV_COUNT = 24; // 6 faces * 4 verts (BoxGeometry)

/** Throw strength passed to combat.throwGrenade (m/s launch speed). */
export const GRENADE_POWER = 16;

export class Interact {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    /** Targeted block hit {x,y,z,id,normal,point,distance} or null */
    this.target = null;
    /** Targeted entity hit {entity, distance, point} within punch range, or null */
    this.entityTarget = null;
    /** Block currently being mined {x,y,z,id} or null; progress 0..1 */
    this.mining = null;
    this.progress = 0;

    this._breakCd = 0;
    this._punchCd = 0;
    this._placeCd = 0;
    this._hitSndT = 0;
    this._swingT = 0;
    this._meleeAnimT = 0;
    this._grenadeT = 0;
    this._creativeOreNote = false;
    this._placedOreNote = false;
    this._ray = { origin: new THREE.Vector3(), dir: new THREE.Vector3() };
    this._eye = new THREE.Vector3();
    this._start = new THREE.Vector3();
    this._crackStage = -1;
    this._crackAtlas = null;
    this._primed = [];
    this.highlight = null;
    this.face = null;
    this.crack = null;
  }

  init() {
    const scene = this.game.scene;
    // wireframe outline (slightly enlarged so it never z-fights)
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this._hlMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false });
    this.highlight = new THREE.LineSegments(edges, this._hlMat);
    this.highlight.visible = false;
    this.highlight.renderOrder = 2;
    scene.add(this.highlight);
    // faint fill on the targeted face (shows where a block will be placed; helps a lot in third person)
    this._faceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false });
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._faceMat);
    this.face.visible = false;
    this.face.renderOrder = 2;
    scene.add(this.face);
    // crack overlay
    this._crackGeo = new THREE.BoxGeometry(1.006, 1.006, 1.006);
    this._crackMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, fog: false });
    this.crack = new THREE.Mesh(this._crackGeo, this._crackMat);
    this.crack.visible = false;
    this.crack.renderOrder = 3;
    scene.add(this.crack);
  }

  /** Stop mining and hide all target visuals. */
  cancel() {
    this.target = null;
    this.entityTarget = null;
    this._resetMining();
    if (this.highlight) this.highlight.visible = false;
    if (this.face) this.face.visible = false;
    if (this.crack) this.crack.visible = false;
    const hud = this.game.hud;
    if (hud) hud.miningProgress = null;
  }

  /** Per-frame (called by Player while on foot and alive). */
  update(dt) {
    const g = this.game, p = this.player, input = g.input;
    const inv = g.inventory;
    const item = inv && inv.getSelected ? inv.getSelected() : null;
    // hands up (surrender) counts as frozen: no fire, mine, place or grenade
    const frozen = !!p.frozen || !!p.handsUp;
    this._breakCd -= dt; this._punchCd -= dt; this._placeCd -= dt; this._hitSndT -= dt; this._swingT -= dt;
    this._meleeAnimT -= dt; this._grenadeT -= dt;

    if (!frozen && input.pressed('grenade')) this._quickGrenade(item);

    // ---------------- weapon selected: Combat drives it
    if (item && item.kind === 'weapon') {
      this.target = null; this.entityTarget = null;
      this._resetMining();
      this._hideVisuals();
      const swimming = p.inWater && !p.onGround;
      const can = !frozen && !swimming;
      const aim = can && input.down('aim');
      const firing = can && input.down('attack');
      const firingPressed = can && input.pressed('attack');
      p.aiming = aim;
      const combat = g.combat;
      if (combat && typeof combat.updatePlayerWeapon === 'function') {
        combat.updatePlayerWeapon(dt, item, { firing, firingPressed, aiming: aim, reloadPressed: can && input.pressed('reload') });
      }
      if (firing) p.noteAction();
      const def = WEAPONS[item.id];
      if (def && def.kind === 'melee' && firingPressed && this._meleeAnimT <= 0) {
        // swing visuals for bats (Combat resolves the hit)
        this._meleeAnimT = 1 / Math.max(0.5, def.rate || 1.5);
        p.humanoid?.punch?.();
        g.cameraRig?.viewModel?.swing?.();
      }
      return;
    }
    p.aiming = false;

    // ---------------- hand / tool / block: Minecraft interaction
    this._findTargets();
    const attackDown = !frozen && input.down('attack');
    const attackPressed = !frozen && input.pressed('attack');
    const useDown = !frozen && input.down('aim');
    const usePressed = !frozen && input.pressed('aim');

    if (attackDown && this.entityTarget) {
      this._resetMining();
      if (this._punchCd <= 0) this._punch(item, this.entityTarget);
    } else if (attackDown && this.target) {
      this._mine(dt, item, attackPressed);
    } else {
      this._resetMining();
      if (attackPressed && this._punchCd <= 0) this._punch(item, null); // swing at the air
    }

    // place / use
    if (useDown && this.target) {
      if (usePressed || this._placeCd <= 0) {
        if (item && item.kind === 'block') {
          if (this._place(item)) this._placeCd = INTERACT.placeRepeat;
          else this._placeCd = 0.1;
        } else if (usePressed && this.target.id === B.TNT) {
          this._igniteTNT(this.target.x, this.target.y, this.target.z);
          this._placeCd = 0.3;
        }
      }
    } else if (!useDown) this._placeCd = 0;

    if (!frozen && input.pressed('pick') && this.target) {
      if (g.inventory && g.inventory.pickBlock) {
        if (g.inventory.pickBlock(this.target.id)) g.audio?.play?.('ui_click', { volume: 0.3 });
      }
    }

    this._updateVisuals();
  }

  /** lateUpdate-ish ticking that must also run while in a vehicle / dead (primed TNT). */
  tick(dt) {
    if (this._primed.length) this._updatePrimed(dt);
  }

  // ------------------------------------------------------------------ targeting

  _findTargets() {
    const g = this.game, p = this.player, w = g.world;
    this.target = null;
    this.entityTarget = null;
    const rig = g.cameraRig;
    if (!w || !rig || typeof rig.getAimRay !== 'function') return;
    rig.getAimRay(this._ray);
    const o = this._ray.origin, d = this._ray.dir;
    p.getEyePosition(this._eye);
    const eye = this._eye;
    // start near the player: skip the stretch between a third-person camera and the character
    const proj = (eye.x - o.x) * d.x + (eye.y - o.y) * d.y + (eye.z - o.z) * d.z;
    const t0 = Math.max(0, proj - 1.25);
    this._start.copy(o).addScaledVector(d, t0);
    const maxD = INTERACT.reach + Math.max(0, proj - t0) + 1.5;
    let hit = null;
    try { hit = voxelRaycast(w, this._start, d, maxD, { hitNonSolid: true, hitLiquid: false }); } catch (e) { hit = null; }
    if (hit && hit.normal.lengthSq() > 0.5 && hit.point.distanceTo(eye) <= INTERACT.reach) this.target = hit;
    // entity in punch reach (closer than the block)
    const ents = g.entities;
    if (ents && typeof ents.raycast === 'function') {
      const eh = ents.raycast(this._start, d, Math.min(maxD, INTERACT.punchRange + Math.max(0, proj - t0) + 0.5), p,
        (e) => e.alive !== false && e.kind !== 'tnt');
      if (eh && eh.point.distanceTo(eye) <= INTERACT.punchRange && (!hit || eh.distance < hit.distance)) this.entityTarget = eh;
    }
  }

  // ------------------------------------------------------------------ mining

  _resetMining() {
    if (this.mining) { this.mining = null; this.progress = 0; }
    const hud = this.game.hud;
    if (hud && hud.miningProgress !== null && hud.miningProgress !== undefined) hud.miningProgress = null;
  }

  _mine(dt, item, pressed) {
    const g = this.game, t = this.target, p = this.player;
    const def = BLOCKS[t.id];
    if (!def) return;
    const m = this.mining;
    if (!m || m.x !== t.x || m.y !== t.y || m.z !== t.z || m.id !== t.id) {
      this.mining = { x: t.x, y: t.y, z: t.z, id: t.id };
      this.progress = 0;
      this._hitSndT = 0;
    }
    p.noteAction();
    if (this._breakCd > 0 && !pressed) return;
    const creative = !!(g.inventory && g.inventory.creative);
    let bt = breakTime(t.id, toolOf(item));
    if (!Number.isFinite(bt)) {
      // unbreakable (bedrock): swing + dull clink, no progress
      this._swingAnim();
      if (this._hitSndT <= 0) { this._hitSndT = 0.4; g.audio?.play?.('block_hit', { position: _v.set(t.x + 0.5, t.y + 0.5, t.z + 0.5), volume: 0.5, pitch: 0.6 }); }
      if (g.hud) g.hud.miningProgress = null;
      return;
    }
    if (creative) bt = 0;
    if (bt <= 0.05) {
      this._swingAnim(true);
      this._break(t, item);
      this._breakCd = creative ? 0.2 : INTERACT.breakCooldown;
      this.mining = null; this.progress = 0;
      if (g.hud) g.hud.miningProgress = null;
      return;
    }
    this.progress += dt / bt;
    this._swingAnim();
    if (this._hitSndT <= 0) {
      this._hitSndT = INTERACT.hitSoundInterval;
      const c = _v.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
      g.audio?.play?.('block_hit', { position: c, volume: 0.55, pitch: 0.85 + Math.random() * 0.3 });
      // chips flying off the face
      _v2.copy(t.point).addScaledVector(t.normal, 0.05);
      g.fx?.burst?.(_v2, { color: def.color, count: 3, speed: 2.2, size: 0.07, life: 0.45, gravity: 16 });
    }
    if (g.hud) g.hud.miningProgress = Math.min(1, this.progress);
    if (this.progress >= 1) {
      this._break(t, item);
      this.mining = null;
      this.progress = 0;
      this._breakCd = INTERACT.breakCooldown;
      if (g.hud) g.hud.miningProgress = null;
    }
  }

  /** Break the block at hit `t`. Returns true when the block was removed. */
  _break(t, item) {
    const g = this.game, w = g.world, p = this.player;
    const { x, y, z, id } = t;
    const def = BLOCKS[id];
    if (!def || !Number.isFinite(def.hardness) || def.liquid) return false;
    // player-placed? (world.edits records every placement; generated blocks never appear there). Must be read
    // before _setBlock, which overwrites the edit entry with 0.
    const placed = !!(w && w.edits && typeof w.edits.get === 'function' && w.edits.get(x + ',' + y + ',' + z) === id);
    if (!this._setBlock(x, y, z, 0)) return false;
    const inv = g.inventory;
    const creative = !!(inv && inv.creative);
    _v.set(x + 0.5, y + 0.5, z + 0.5);
    g.fx?.blockBreak?.(x, y, z, id);
    g.audio?.play?.('block_break', { position: _v, pitch: 0.9 + Math.random() * 0.2 });
    // ores never become items (they pay cash instead): an ore that still drops itself yields cobblestone
    let drop = def.drops;
    if (drop && isOreBlock(drop)) drop = B.COBBLESTONE || 0;
    if (!creative && drop && inv && inv.addBlock) inv.addBlock(drop, 1);
    if (def.value > 0) {
      if (creative) {
        if (!this._creativeOreNote) {
          this._creativeOreNote = true;
          g.hud?.notify?.('Creative mode: ores pay nothing', { duration: 3 });
        }
      } else if (placed) {
        if (!this._placedOreNote) {
          this._placedOreNote = true;
          g.hud?.notify?.('Placed ore pays nothing', { duration: 3 });
        }
      } else {
        p.addMoney(def.value, 'mining');
        g.hud?.notify?.('+$' + def.value + ' ' + def.name, { color: '#46c46f', duration: 2.5 });
        g.audio?.play?.('money', { volume: 0.7 });
      }
    }
    g.events.emit('blockBroken', { x, y, z, id, byPlayer: true, natural: !placed });
    // a plant standing on the broken block pops off too
    const above = w.getBlock(x, y + 1, z);
    const ad = BLOCKS[above];
    const abovePlaced = !!(ad && w.edits && typeof w.edits.get === 'function' && w.edits.get(x + ',' + (y + 1) + ',' + z) === above);
    if (ad && ad.shape === 'cross' && !ad.solid && this._setBlock(x, y + 1, z, 0)) {
      g.fx?.blockBreak?.(x, y + 1, z, above);
      if (!creative && ad.drops && inv && inv.addBlock) inv.addBlock(ad.drops, 1);
      g.events.emit('blockBroken', { x, y: y + 1, z, id: above, byPlayer: true, natural: !abovePlaced });
    }
    this._swingAnim(true);
    p.noteAction();
    return true;
  }

  _setBlock(x, y, z, id) {
    const w = this.game.world;
    if (!w || typeof w.setBlock !== 'function') return false;
    let ok = false;
    try { ok = w.setBlock(x, y, z, id); } catch (e) { ok = false; }
    if (ok === false) {
      // tolerate worlds that return undefined: verify
      try { return w.getBlock(x, y, z) === id; } catch (e) { return false; }
    }
    return true;
  }

  // ------------------------------------------------------------------ placing

  _place(item) {
    const g = this.game, w = g.world, t = this.target, p = this.player;
    const def = BLOCKS[item.id];
    if (!def || item.id === 0 || !isPlaceableBlock(item.id)) return false; // also refuses ores (old saves)
    if (!(item.count > 0) && !(g.inventory && g.inventory.creative)) return false;
    let x, y, z;
    const td = BLOCKS[t.id];
    if (td && td.shape === 'cross' && !td.solid) { x = t.x; y = t.y; z = t.z; } // replace grass / flowers
    else { x = t.x + Math.round(t.normal.x); y = t.y + Math.round(t.normal.y); z = t.z + Math.round(t.normal.z); }
    if (y < 1 || y >= WORLD.HEIGHT || x < 0 || z < 0 || x >= WORLD.SIZE_X || z >= WORLD.SIZE_Z) return false;
    const cur = w.getBlock(x, y, z);
    const cd = BLOCKS[cur];
    if (cur !== 0 && !(cd && (cd.liquid || (cd.shape === 'cross' && !cd.solid)))) return false;
    if (def.shape === 'cross' && !w.isSolid(x, y - 1, z)) return false; // plants need ground
    if (def.solid && this._blockedByEntity(x, y, z)) return false;
    // keep placement reachable (no placing through the back of your own head in third person)
    _v.set(x + 0.5, y + 0.5, z + 0.5);
    if (_v.distanceTo(this._eye) > INTERACT.reach + 1.0) return false;
    if (!this._setBlock(x, y, z, item.id)) return false;
    g.inventory?.consumeSelected?.(1);
    g.audio?.play?.('block_place', { position: _v, pitch: 0.9 + Math.random() * 0.2 });
    this._swingAnim(true);
    p.noteAction();
    g.events.emit('blockPlaced', { x, y, z, id: item.id, byPlayer: true });
    return true;
  }

  /** True when any live entity's box overlaps block (x,y,z). */
  _blockedByEntity(x, y, z) {
    const ents = this.game.entities;
    if (!ents) return false;
    _v.set(x + 0.5, y + 0.5, z + 0.5);
    const list = ents.query(_v, 9, null, _q);
    for (const e of list) {
      if (e.alive === false) continue;
      entityBox(e, _box);
      if (_box.min.x < x + 1 - 1e-3 && _box.max.x > x + 1e-3 && _box.min.y < y + 1 - 1e-3 && _box.max.y > y + 1e-3 &&
          _box.min.z < z + 1 - 1e-3 && _box.max.z > z + 1e-3) return true;
    }
    // the player itself (also when the registry query misses it)
    const p = this.player;
    entityBox(p, _box);
    return _box.min.x < x + 1 && _box.max.x > x && _box.min.y < y + 1 && _box.max.y > y && _box.min.z < z + 1 && _box.max.z > z;
  }

  // ------------------------------------------------------------------ punching / animation

  _punch(item, hit) {
    const g = this.game, p = this.player;
    this._punchCd = INTERACT.punchCooldown;
    const dmg = meleeDamage(item);
    const eye = p.getEyePosition(this._eye);
    const dir = _v2;
    if (hit && hit.point) dir.subVectors(hit.point, eye).normalize();
    else dir.copy(this._ray.dir);
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.copy(this._ray.dir);
    this._swingAnim(true);
    g.audio?.play?.('melee_swing', { position: eye, volume: 0.45, pitch: 0.95 + Math.random() * 0.15 });
    const combat = g.combat;
    if (combat && typeof combat.melee === 'function') {
      try { combat.melee(p, eye.clone(), dir.clone(), dmg, INTERACT.punchRange); } catch (e) { console.error('[player] melee', e); }
    }
    p.noteAction();
  }

  /** Arm / view-model swing (rate-limited unless force). */
  _swingAnim(force = false) {
    if (!force && this._swingT > 0) return;
    this._swingT = INTERACT.swingInterval;
    this.player.humanoid?.punch?.();
    this.game.cameraRig?.viewModel?.swing?.();
  }

  // ------------------------------------------------------------------ grenade quick-throw (G)

  _quickGrenade(selected) {
    const g = this.game, p = this.player, combat = g.combat, inv = g.inventory;
    if (!combat || combat.handlesGrenadeKey || typeof combat.throwGrenade !== 'function' || !inv) return;
    if (selected && selected.kind === 'weapon' && selected.id === 'grenade') return; // Combat handles it as the held weapon
    if (this._grenadeT > 0 || (p.inWater && !p.onGround)) return;
    const it = inv.getWeapon ? inv.getWeapon('grenade') : null;
    if (!it || (it.mag | 0) + (it.reserve | 0) <= 0) {
      g.hud?.notify?.('No grenades', { duration: 1.5 });
      g.audio?.play?.('empty_click', { volume: 0.5 });
      this._grenadeT = 0.6;
      return;
    }
    this._grenadeT = 0.9;
    const rig = g.cameraRig;
    rig.getAimRay(this._ray);
    const eye = p.getEyePosition(this._eye);
    const origin = eye.clone();
    const right = _v.set(-Math.cos(p.yaw), 0, Math.sin(p.yaw));
    origin.addScaledVector(right, 0.3);
    origin.y -= 0.15;
    const dir = this._ray.dir.clone();
    dir.y += 0.18;
    dir.normalize();
    try { combat.throwGrenade(p, origin, dir, GRENADE_POWER); } catch (e) { console.error('[player] throwGrenade', e); return; }
    if ((it.mag | 0) > 0) it.mag--; else it.reserve--;
    if (it.mag <= 0 && it.reserve > 0) { it.mag = 1; it.reserve--; }
    inv.notifyChanged?.();
    p.yaw = rig.yaw;
    this._swingAnim(true);
    p.noteAction();
  }

  // ------------------------------------------------------------------ hand-lit TNT (RMB on TNT with no block in hand)

  _igniteTNT(x, y, z) {
    const g = this.game, combat = g.combat;
    if (combat && typeof combat.primeTNT === 'function') {
      try { combat.primeTNT(x, y, z, this.player); this._swingAnim(true); return; } catch (e) { /* fall back */ }
    }
    if (!combat || typeof combat.explode !== 'function') return;
    if (!this._setBlock(x, y, z, 0)) return;
    const mesh = this._makePrimedMesh();
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    g.scene.add(mesh);
    this._primed.push({ mesh, x, y, z, fuse: 3.0, t: 0 });
    g.audio?.play?.('tnt_fuse', { position: mesh.position });
    g.events.emit('blockBroken', { x, y, z, id: B.TNT, byPlayer: true });
    this._swingAnim(true);
  }

  _makePrimedMesh() {
    const tex = this.game.world && this.game.world.textures;
    let geo = tex && tex.atlasTexture ? blockCubeGeometry(tex, B.TNT) : null;
    let mat;
    if (geo) mat = new THREE.MeshLambertMaterial({ map: tex.atlasTexture, emissive: 0xffffff, emissiveIntensity: 0 });
    else { geo = blockColorGeometry(tex, B.TNT); mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0 }); }
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  _updatePrimed(dt) {
    const g = this.game;
    for (let i = this._primed.length - 1; i >= 0; i--) {
      const t = this._primed[i];
      t.t += dt;
      const flash = Math.sin(t.t * (6 + t.t * 6)) > 0.2;
      t.mesh.material.emissiveIntensity = flash ? 0.85 : 0;
      const s = 1 + Math.max(0, t.t - t.fuse + 0.6) * 0.25;
      t.mesh.scale.setScalar(s);
      if (t.t >= t.fuse) {
        this._primed.splice(i, 1);
        g.scene.remove(t.mesh);
        t.mesh.geometry.dispose(); t.mesh.material.dispose();
        try {
          g.combat.explode(new THREE.Vector3(t.x + 0.5, t.y + 0.5, t.z + 0.5), { radius: 4.5, power: 3, damage: 140, source: this.player });
        } catch (e) { console.error('[player] TNT explode', e); }
      }
    }
  }

  // ------------------------------------------------------------------ visuals

  _hideVisuals() {
    if (this.highlight) this.highlight.visible = false;
    if (this.face) this.face.visible = false;
    if (this.crack) this.crack.visible = false;
  }

  _updateVisuals() {
    const t = this.target;
    if (!this.highlight) return;
    if (!t || this.entityTarget) { this._hideVisuals(); return; }
    const def = BLOCKS[t.id];
    const cross = def && def.shape === 'cross';
    const night = (this.game.sky && this.game.sky.nightFactor) || 0;
    const col = night > 0.55 ? 0xffffff : 0x000000;
    if (this._hlMat.color.getHex() !== col) { this._hlMat.color.setHex(col); this._hlMat.opacity = night > 0.55 ? 0.5 : 0.6; }
    this.highlight.visible = true;
    if (cross) {
      this.highlight.scale.set(0.7, 0.85, 0.7);
      this.highlight.position.set(t.x + 0.5, t.y + 0.425, t.z + 0.5);
      this.face.visible = false;
    } else {
      this.highlight.scale.set(1, 1, 1);
      this.highlight.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
      this.face.visible = true;
      const n = t.normal;
      this.face.position.set(t.x + 0.5 + n.x * 0.503, t.y + 0.5 + n.y * 0.503, t.z + 0.5 + n.z * 0.503);
      _v.copy(this.face.position).add(n);
      this.face.lookAt(_v);
    }
    // crack overlay
    const m = this.mining;
    if (m && this.progress > 0.001 && m.x === t.x && m.y === t.y && m.z === t.z && !cross) {
      this.crack.visible = true;
      this.crack.position.set(m.x + 0.5, m.y + 0.5, m.z + 0.5);
      this._setCrackStage(Math.min(9, Math.floor(this.progress * 10)));
    } else this.crack.visible = false;
  }

  _setCrackStage(stage) {
    const tex = this.game.world && this.game.world.textures;
    const atlas = tex && tex.atlasTexture;
    let rect = null;
    if (atlas && typeof tex.uvFor === 'function') {
      try { rect = tex.uvFor('destroy_' + stage); } catch (e) { rect = null; }
    }
    if (rect && Number.isFinite(rect.u0)) {
      if (this._crackAtlas !== atlas) {
        this._crackAtlas = atlas;
        this._crackMat.map = atlas;
        this._crackMat.color.setHex(0xffffff);
        this._crackMat.opacity = 0.95;
        this._crackMat.alphaTest = 0.01;
        this._crackMat.needsUpdate = true;
        this._crackStage = -1;
      }
      if (stage === this._crackStage) return;
      this._crackStage = stage;
      // rebuild UVs: every face shows the destroy tile
      const uv = this._crackGeo.attributes.uv;
      const base = [0, 1, 1, 1, 0, 0, 1, 0];
      for (let i = 0; i < FACE_UV_COUNT; i++) {
        const u = base[(i % 4) * 2], v = base[(i % 4) * 2 + 1];
        uv.setXY(i, rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0));
      }
      uv.needsUpdate = true;
    } else {
      // fallback: progressive darkening
      if (this._crackMat.map) { this._crackMat.map = null; this._crackMat.needsUpdate = true; this._crackAtlas = null; }
      this._crackMat.color.setHex(0x000000);
      this._crackMat.opacity = 0.08 + stage * 0.05;
      this._crackStage = stage;
    }
  }

  dispose() {
    for (const o of [this.highlight, this.face, this.crack]) {
      if (!o) continue;
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose();
    }
    for (const t of this._primed) { if (t.mesh.parent) t.mesh.parent.remove(t.mesh); }
    this._primed.length = 0;
  }
}
