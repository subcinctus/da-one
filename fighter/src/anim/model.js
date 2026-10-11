// STUB - ANIM agent. See FIGHTER.md §Anim.
import * as THREE from 'three';
import { createSkeleton } from './rig.js';
export function createFighterModel(look = {}) {
  const skel = createSkeleton();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.25), new THREE.MeshStandardMaterial({ color: 0xcccccc }));
  m.position.y = -0.1; skel.joints.chest.add(m);
  return { root: skel.root, skeleton: skel, look, dispose() {} };
}
