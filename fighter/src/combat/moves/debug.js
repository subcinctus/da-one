// Debug helpers for the move library (installed on game.debug; dev / QA only, nothing runs per frame).
//   game.debug.movePreview(id, { own, times, at, spacing }) -> ghost lineup at start / anticipation / hit / follow / end
//   game.debug.clearMovePreview()
//   game.debug.moveSummary(id)    frame data + chain timing summary
//   game.debug.validateMoves()    validation issues (schema, frame data, flow graph, decks, pose QA)
//   game.debug.moveIds(filter?)   ids (filter: 'player' | 'boss' | 'focus' | stance)
// Uses ANIM's game.debug.posePreview when present (real fighter models); otherwise draws its own box mannequins.
import * as THREE from 'three';
import { createSkeleton, PoseBuffer, sampleTrack, hasPose } from '../../anim/rig.js';
import { registerReferenceStances } from './stances-ref.js';
import { validateLibrary } from './validate.js';

let LIB = null;
/** index.js hands the assembled library over (avoids an import cycle). */
export function attachMoves(lib) { LIB = lib; }

/** Key preview times of a move: start, anticipation, hit, follow-through, end. */
export function previewTimes(m) {
  const pre = m.keys.filter((k) => k.t > 0 && k.t < m.startup - 1e-4);
  const antic = pre.length ? pre[pre.length - 1].t : m.startup * 0.6;
  return [0, antic, m.startup, m.startup + m.active + m.recovery * 0.4, m.duration];
}

let _ghosts = null;
let _group = null;
function ghostRig(scene, n) {
  if (!_group) { _group = new THREE.Group(); _group.name = 'movePreview'; }
  if (!_group.parent) scene.add(_group);
  _ghosts = _ghosts || [];
  const matR = new THREE.MeshLambertMaterial({ color: 0xd2453a }), matL = new THREE.MeshLambertMaterial({ color: 0x3a6fd2 });
  const matT = new THREE.MeshLambertMaterial({ color: 0xa0a0a0 }), matH = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
  const seg = (bone, len, w, mat, dir = -1) => {
    const g = new THREE.BoxGeometry(w, len, w); g.translate(0, dir * len / 2, 0);
    bone.add(new THREE.Mesh(g, mat));
  };
  while (_ghosts.length < n) {
    const sk = createSkeleton();
    const j = sk.joints;
    j.hips.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.18), matT));
    seg(j.spine, 0.2, 0.24, matT, 1);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.2), matT); torso.position.y = 0.12; j.chest.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.22), matH); head.position.y = 0.1; j.head.add(head);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.1), matT); nose.position.set(0, 0.1, 0.13); j.head.add(nose);
    for (const s of ['L', 'R']) {
      const m = s === 'L' ? matL : matR;
      seg(j['shoulder' + s], 0.28, 0.09, m); seg(j['elbow' + s], 0.25, 0.075, m);
      const fist = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), m); fist.position.y = -0.05; j['wrist' + s].add(fist);
      seg(j['thigh' + s], 0.44, 0.12, m); seg(j['knee' + s], 0.42, 0.095, m);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.24), m); foot.position.set(0, -0.04, 0.07); j['ankle' + s].add(foot);
    }
    _ghosts.push({ sk, pb: new PoseBuffer() });
  }
  for (const g of _ghosts) if (g.sk.root.parent) g.sk.root.parent.remove(g.sk.root);
  return _ghosts.slice(0, n);
}

function clearPreview() {
  if (_group?.parent) _group.parent.remove(_group);
  if (_ghosts) for (const g of _ghosts) if (g.sk.root.parent) g.sk.root.parent.remove(g.sk.root);
}

/** Lay out ghost copies of a move at key times in front of the camera (strikes travel toward screen right). */
export function movePreview(game, id, opts = {}) {
  const m = typeof id === 'string' ? LIB?.MOVES?.[id] : id;
  if (!m || !m.keys) return null;
  const times = opts.times || previewTimes(m);
  if (!opts.own && typeof game.debug?.posePreview === 'function' && game.debug.posePreview !== game.debug.movePreview) {
    try { return game.debug.posePreview(m, times, opts); } catch (e) { /* fall back to our own ghosts */ }
  }
  // placeholder stances only when nobody registered them yet (debug only; ANIM's poses win when present)
  if (!hasPose('stance:FR')) registerReferenceStances();
  const scene = game.scene, cam = game.camera;
  if (!scene || !cam) return null;
  const ghosts = ghostRig(scene, times.length);
  const fwd = new THREE.Vector3(), right = new THREE.Vector3();
  cam.getWorldDirection(fwd); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  fwd.normalize();
  right.set(-fwd.z, 0, fwd.x); // camera right on the ground plane
  const spacing = opts.spacing || 1.45;
  const center = opts.at ? new THREE.Vector3(opts.at.x, 0, opts.at.z)
    : new THREE.Vector3(cam.position.x, 0, cam.position.z).addScaledVector(fwd, opts.distance || 5.5);
  const yaw = Math.atan2(right.x, right.z) + (opts.turn ?? 0.35); // fighter forward = camera right, turned a bit toward us
  ghosts.forEach((g, i) => {
    sampleTrack(m, times[i], g.pb);
    g.pb.applyTo(g.sk);
    g.sk.root.position.copy(center).addScaledVector(right, (i - (times.length - 1) / 2) * spacing);
    g.sk.root.rotation.set(0, yaw, 0);
    _group.add(g.sk.root);
  });
  _group.updateMatrixWorld(true);
  return { id: m.id, times, ghosts: ghosts.length, clear: clearPreview };
}

/** Frame data + chain timing summary for one move. */
export function moveInfo(id) {
  const m = LIB?.MOVES?.[id];
  if (!m) return null;
  const hitEnd = m.hits.reduce((t, h) => Math.max(t, h.t + h.dur), 0);
  return {
    id: m.id, name: m.name, start: m.start, end: m.end, weight: m.weight, height: m.height, path: m.path, limb: m.limb,
    startup: m.startup, active: m.active, recovery: m.recovery, duration: m.duration, cancel: m.cancel,
    chainIn: m.chainIn, holdOut: m.holdOut, chainedStrikeIn: +(m.startup - m.chainIn).toFixed(3),
    hitEnd, props: Object.keys(m.props || {}), damage: m.damage, stamina: m.stamina, boss: m.boss, keys: m.keys.length,
  };
}

/** Install the helpers on game.debug (idempotent). Combat may call this in init(); it also self-installs. */
export function installMovesDebug(game) {
  if (!game?.debug || game.debug.__movesDebug) return;
  game.debug.__movesDebug = true;
  game.debug.movePreview = (id, opts) => movePreview(game, id, opts);
  game.debug.clearMovePreview = () => clearPreview();
  game.debug.moveSummary = (id) => moveInfo(id);
  game.debug.validateMoves = (poseQA = true) => (LIB ? validateLibrary({ ...LIB, poseQA }) : ['library not attached']);
  game.debug.moveIds = (filter) => Object.values(LIB?.MOVES || {}).filter((m) =>
    !filter || (filter === 'player' ? !m.boss && !m.focus : filter === 'boss' ? m.boss : filter === 'focus' ? m.focus : m.start === filter)).map((m) => m.id);
}

if (typeof window !== 'undefined' && typeof setTimeout === 'function') {
  let tries = 0;
  const tick = () => { const g = window.game; if (g && g.debug) installMovesDebug(g); else if (++tries < 400) setTimeout(tick, 50); };
  setTimeout(tick, 0);
}
