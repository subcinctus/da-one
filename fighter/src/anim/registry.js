// Shared animation data: baked poses, locomotion cycles and clips. Built once, lazily (the AnimLibrary system
// builds it in init(); an Animator created earlier, e.g. by a test, builds it on demand).
import { PoseBuffer } from './rig.js';
import { registerBasePoses, buildLocomotion, POSES, STANCES } from './poses.js';
import { buildClips } from './clips.js';

export const CLIPS = new Map();
export const CLIP_NAMES = [];
/** Precompiled PoseBuffers: STANCE_BUF.FR, GUARD_BUF.FR, CROUCH_BUF.FR, NEUTRAL_BUF. */
export const STANCE_BUF = {};
export const GUARD_BUF = {};
export const CROUCH_BUF = {};
export const LOCO = { walk: null, run: null };
let built = false;

/** Build poses, locomotion and clips (idempotent). */
export function ensureAnimData() {
  if (built) return;
  built = true;
  registerBasePoses();
  for (const st of STANCES) {
    STANCE_BUF[st] = new PoseBuffer().setPose(POSES['stance:' + st]);
    GUARD_BUF[st] = new PoseBuffer().setPose(POSES['guard:' + st]);
    CROUCH_BUF[st] = new PoseBuffer().setPose(POSES['crouch:' + st]);
  }
  STANCE_BUF.neutral = new PoseBuffer().setPose(POSES.neutral);
  const loco = buildLocomotion();
  LOCO.walk = loco.walk;
  LOCO.run = loco.run;
  const names = buildClips((name, track) => { CLIPS.set(name, track); });
  CLIP_NAMES.push(...names);
}

/** Clip for a stance: '<name>@<stance>' first, then '<name>'. */
export function getClip(name, stance) {
  if (stance) { const v = CLIPS.get(name + '@' + stance); if (v) return v; }
  return CLIPS.get(name) || null;
}

/** Register (or override) a clip at runtime, e.g. a boss-specific gesture. */
export function registerClip(name, track) { if (!track.name) track.name = name; CLIPS.set(name, track); return track; }
