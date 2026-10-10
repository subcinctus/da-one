// Compact text codec for world edits (pure; node-testable).
// Edits are sorted by packed position p = (y * 512 + z) * 512 + x and run-length encoded: consecutive positions with
// the same block id (typical for explosion craters, walls, floors) collapse into one token.
//   "E1:" + tokens joined by ','   token = delta36 '.' id36 [ '.' extra36 ]   (extra = run length - 1)
import { WORLD } from '../core/config.js';

const SX = WORLD.SIZE_X, SZ = WORLD.SIZE_Z, H = WORLD.HEIGHT;
export const EDIT_PREFIX = 'E1:';

export const packPos = (x, y, z) => (y * SZ + z) * SX + x;
export function unpackPos(p) {
  const x = p % SX;
  const r = (p - x) / SX;
  const z = r % SZ;
  const y = (r - z) / SZ;
  return [x, y, z];
}

/**
 * Encode edits. `src`: Map<'x,y,z', id> | flat [x,y,z,id,...] | array of [x,y,z,id]. Keeps at most `limit` entries
 * (the most recently inserted ones for a Map). Returns { text, count }.
 */
export function encodeEdits(src, limit = 50000) {
  const list = [];
  const push = (x, y, z, id) => {
    x = Math.floor(+x); y = Math.floor(+y); z = Math.floor(+z); id = id | 0;
    if (!(x >= 0 && x < SX && z >= 0 && z < SZ && y >= 0 && y < H) || id < 0 || id > 255) return;
    list.push(packPos(x, y, z) * 256 + id);
  };
  if (src instanceof Map) {
    const skip = Math.max(0, src.size - limit);
    let i = 0;
    for (const [k, id] of src) {
      if (i++ < skip) continue;
      const a = String(k).split(',');
      if (a.length === 3) push(a[0], a[1], a[2], id);
    }
  } else if (Array.isArray(src)) {
    if (src.length && typeof src[0] === 'number') {
      const n = Math.floor(src.length / 4);
      const start = Math.max(0, n - limit);
      for (let i = start; i < n; i++) push(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], src[i * 4 + 3]);
    } else {
      const start = Math.max(0, src.length - limit);
      for (let i = start; i < src.length; i++) { const e = src[i]; if (Array.isArray(e) && e.length >= 4) push(e[0], e[1], e[2], e[3]); else if (e && typeof e === 'object') push(e.x, e.y, e.z, e.id); }
    }
  }
  // packed*256+id < 2^53: sort numerically, keep the last write for duplicate positions (stable after sort by pos)
  list.sort((a, b) => a - b);
  const toks = [];
  let prev = 0;
  let count = 0;
  for (let i = 0; i < list.length;) {
    const p = Math.floor(list[i] / 256), id = list[i] % 256;
    // skip duplicates of the same position (keep the last one in sorted order)
    let j = i + 1;
    while (j < list.length && Math.floor(list[j] / 256) === p) j++;
    const idLast = list[j - 1] % 256;
    let run = 0;
    let k = j;
    let nextP = p + 1;
    while (k < list.length) {
      const q = Math.floor(list[k] / 256);
      if (q !== nextP) break;
      let m = k + 1;
      while (m < list.length && Math.floor(list[m] / 256) === q) m++;
      if (list[m - 1] % 256 !== idLast) break;
      run++;
      nextP++;
      k = m;
    }
    void id;
    toks.push((p - prev).toString(36) + '.' + idLast.toString(36) + (run ? '.' + run.toString(36) : ''));
    count += run + 1;
    prev = p + run;
    i = k;
  }
  return { text: EDIT_PREFIX + toks.join(','), count };
}

/** Decode to a flat [x,y,z,id, ...] array (accepted by world.applyEdits). Invalid input -> []. */
export function decodeEdits(text) {
  const out = [];
  if (typeof text !== 'string' || !text.startsWith(EDIT_PREFIX)) {
    // tolerate legacy / raw formats
    if (Array.isArray(text)) return text.slice();
    return out;
  }
  const body = text.slice(EDIT_PREFIX.length);
  if (!body) return out;
  let prev = 0;
  for (const tok of body.split(',')) {
    const parts = tok.split('.');
    if (parts.length < 2) continue;
    const delta = parseInt(parts[0], 36), id = parseInt(parts[1], 36), run = parts.length > 2 ? parseInt(parts[2], 36) : 0;
    if (!Number.isFinite(delta) || !Number.isFinite(id) || !Number.isFinite(run) || delta < 0 || run < 0) continue;
    const p = prev + delta;
    for (let r = 0; r <= run; r++) {
      const [x, y, z] = unpackPos(p + r);
      if (y >= H) break;
      out.push(x, y, z, id);
    }
    prev = p + run;
  }
  return out;
}
