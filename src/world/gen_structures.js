// Landmark structures outside the lot grid: the Granite Peak mine (galleries + ore cavern), the prospector's camp,
// Sunstone Beach (boardwalk, lifeguard towers, beach bar) and the pier with its lighthouse.
import { B } from './blocks.js';
import { makeRng } from '../core/math.js';
import { CL, RY, MINE, BEACH, PIER, h3 } from './gen_const.js';
import { BP, cylinder, setv, fillBox } from './gen_build_core.js';
import { feat, F_PARKLAMP, F_LAMP } from './gen_features.js';

const CAV = MINE.cavern;

/** Mine cavern implicit shape value (<1 inside). */
export function cavernValue(x, y, z) {
  const dx = (x + 0.5 - CAV.cx) / CAV.rx, dy = (y + 0.5 - CAV.cy) / CAV.ry, dz = (z + 0.5 - CAV.cz) / CAV.rz;
  return dx * dx + dy * dy + dz * dz;
}
function cavernAir(x, y, z) {
  if (y <= CAV.floorY) return false;
  const v = cavernValue(x, y, z);
  if (v < 0.9) return true;
  if (v < 1.0) return h3(x, y, z, 404) < 0.55;
  return false;
}
function rampFloor(x) { return x < 140 ? RY : Math.max(MINE.ramp.yBottom, RY - Math.floor((x - 140) / 2)); }

/** Pre-compute guaranteed ore positions on the cavern walls (gold + diamond) - missions rely on them. */
export function mineOres(seed) {
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const out = [];
  const seen = new Set();
  const want = [[B.DIAMOND_ORE, 14], [B.GOLD_ORE, 22], [B.IRON_ORE, 12]];
  for (const [id, n] of want) {
    let tries = 0, got = 0;
    while (got < n && tries++ < 4000) {
      const th = rng() * Math.PI * 2, ph = (rng() - 0.25) * Math.PI * 0.7;
      const s = 1.04 + rng() * 0.12;
      const x = Math.floor(CAV.cx + Math.cos(th) * Math.cos(ph) * CAV.rx * s);
      const y = Math.floor(CAV.cy + Math.sin(ph) * CAV.ry * s);
      const z = Math.floor(CAV.cz + Math.sin(th) * Math.cos(ph) * CAV.rz * s);
      if (y <= CAV.floorY + 0 || y > CAV.cy + CAV.ry - 1) continue;
      if (cavernAir(x, y, z)) continue;
      // must touch a carved cell so it's visible and reachable
      const exposed = cavernAir(x + 1, y, z) || cavernAir(x - 1, y, z) || cavernAir(x, y, z + 1) || cavernAir(x, y, z - 1) || cavernAir(x, y + 1, z);
      if (!exposed) continue;
      const k = x + ',' + y + ',' + z;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x, y, z, id });
      got++;
    }
  }
  // a guaranteed diamond cluster on the cavern floor at the far end (y just above the floor)
  const fx = CAV.cx + CAV.rx - 4, fz = CAV.cz;
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]) out.push({ x: fx + dx, y: CAV.floorY + 1 + dy, z: fz + dz, id: B.DIAMOND_ORE });
  return out;
}

export function buildMine(seed, P) {
  const bp = new BP({ id: -1, x0: 128, z0: 26, x1: 200, z1: 54, seed: 7331 }, seed, P);
  const A = MINE.tunnelA, R = MINE.ramp;
  const cbx0 = CAV.cx - CAV.rx - 3, cbx1 = CAV.cx + CAV.rx + 3, cbz0 = CAV.cz - CAV.rz - 3, cbz1 = CAV.cz + CAV.rz + 3;
  // 1) ore-rich rock shell around the cavern
  bp.op(cbx0, cbz0, cbx1, cbz1, (c) => {
    const x0 = Math.max(cbx0, c.ox), x1 = Math.min(cbx1, c.ox + 16), z0 = Math.max(cbz0, c.oz), z1 = Math.min(cbz1, c.oz + 16);
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) for (let y = 4; y < CAV.cy + CAV.ry + 3; y++) {
      const v = cavernValue(x, y, z);
      if (v < 0.9 || v > 1.7) continue;
      const k = (x - c.ox) + ((z - c.oz) << 4) + (y << 8);
      const cur = c.data[k];
      if (cur !== B.STONE && cur !== B.DIRT && cur !== B.COBBLESTONE) continue;
      const r = h3(x, y, z, 515);
      if (r < 0.025) c.data[k] = B.DIAMOND_ORE;
      else if (r < 0.065) c.data[k] = B.GOLD_ORE;
      else if (r < 0.13) c.data[k] = B.IRON_ORE;
      else if (r < 0.24) c.data[k] = B.COAL_ORE;
      else if (cur !== B.STONE) c.data[k] = B.STONE;
    }
  });
  // 2) carve the cavern, gravel floor, stone pillars with lamps
  bp.op(cbx0, cbz0, cbx1, cbz1, (c) => {
    const x0 = Math.max(cbx0, c.ox), x1 = Math.min(cbx1, c.ox + 16), z0 = Math.max(cbz0, c.oz), z1 = Math.min(cbz1, c.oz + 16);
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      for (let y = CAV.floorY + 1; y < CAV.cy + CAV.ry + 1; y++) if (cavernAir(x, y, z)) setv(c, x, y, z, B.AIR);
      if (cavernAir(x, CAV.floorY + 1, z)) setv(c, x, CAV.floorY, z, h3(x, 1, z, 9) < 0.4 ? B.GRAVEL : B.STONE);
    }
  });
  for (const [px, pz] of [[CAV.cx - 5, CAV.cz - 4], [CAV.cx + 3, CAV.cz + 4], [CAV.cx + 6, CAV.cz - 5], [CAV.cx - 6, CAV.cz + 5]]) {
    bp.fill(px, CAV.floorY + 1, pz, px + 2, CAV.cy + CAV.ry, pz + 2, B.STONE);
    bp.set(px, CAV.floorY + 4, pz, B.LAMP); bp.set(px + 1, CAV.floorY + 4, pz + 1, B.LAMP);
    bp.set(px + 1, CAV.floorY + 8, pz, B.LAMP);
  }
  // crystal clusters (glowing blue) on the walls
  for (const [qx, qy, qz] of [[CAV.cx + CAV.rx - 2, CAV.cy, CAV.cz - 3], [CAV.cx - 2, CAV.cy + 4, CAV.cz + CAV.rz - 3], [CAV.cx + 2, CAV.cy + 3, CAV.cz - CAV.rz + 3]]) {
    bp.set(qx, qy, qz, B.NEON_BLUE); bp.set(qx, qy + 1, qz, B.GLASS);
  }
  // 3) galleries: flat entrance gallery + descending ramp with timber frames
  bp.op(A.x0, A.z0, A.x1, A.z1, (c) => {
    for (let z = A.z0; z < A.z1; z++) for (let x = A.x0 + 1; x < A.x1 - 1; x++) {
      setv(c, x, RY, z, B.GRAVEL);
      for (let y = CL; y < CL + 5; y++) setv(c, x, y, z, B.AIR);
    }
    for (let z = A.z0; z < A.z1; z += 3) {
      for (let y = CL; y < CL + 4; y++) { setv(c, A.x0 + 1, y, z, B.LOG); setv(c, A.x1 - 2, y, z, B.LOG); }
      for (let x = A.x0 + 1; x < A.x1 - 1; x++) setv(c, x, CL + 4, z, B.PLANKS);
      setv(c, (A.x0 + A.x1) >> 1, CL + 4, z, B.LAMP);
    }
    // portal at the mouth
    const mz = A.z1 - 1;
    for (let y = CL; y < CL + 6; y++) { setv(c, A.x0, y, mz, B.LOG); setv(c, A.x1 - 1, y, mz, B.LOG); }
    for (let x = A.x0; x < A.x1; x++) setv(c, x, CL + 5, mz, B.PLANKS);
    setv(c, A.x0 + 2, CL + 5, mz, B.WOOL_YELLOW); setv(c, A.x0 + 4, CL + 5, mz, B.WOOL_YELLOW);
    setv(c, A.x0, CL + 6, mz, B.LAMP); setv(c, A.x1 - 1, CL + 6, mz, B.LAMP);
  });
  bp.op(A.x0 + 2, R.z0, R.x1 + 4, R.z1, (c) => {
    for (let x = A.x0 + 2; x < R.x1 + 4; x++) {
      const fy = rampFloor(Math.min(x, R.x1 - 1));
      for (let z = R.z0 + 1; z < R.z1 - 1; z++) {
        setv(c, x, fy, z, (x % 4 === 0) ? B.PLANKS : B.GRAVEL);
        for (let y = fy + 1; y < fy + 6; y++) setv(c, x, y, z, B.AIR);
      }
      if (x >= 140 && x % 4 === 0 && x < R.x1) {
        for (let y = fy + 1; y < fy + 5; y++) { setv(c, x, y, R.z0, B.LOG); setv(c, x, y, R.z1 - 1, B.LOG); }
        for (let z = R.z0; z < R.z1; z++) setv(c, x, fy + 5, z, B.PLANKS);
        if (x % 8 === 0) setv(c, x, fy + 5, (R.z0 + R.z1) >> 1, B.LAMP);
      }
    }
  });
  // 4) guaranteed ores (last so nothing overwrites them)
  const ores = mineOres(seed);
  bp.op(cbx0 - 2, cbz0 - 2, cbx1 + 2, cbz1 + 2, (c) => { for (const o of ores) setv(c, o.x, o.y, o.z, o.id); });
  bp.ores = ores;
  return bp;
}

export function buildMineCamp(seed, P) {
  const bp = new BP({ id: -2, x0: 140, z0: 51, x1: 152, z1: 64, seed: 4242 }, seed, P);
  bp.fill(140, RY, 51, 152, RY + 1, 64, B.GRAVEL);
  // shack: door on the west wall facing the mine road
  const x0 = 145, z0 = 55, x1 = 151, z1 = 62;
  bp.fill(x0, CL, z0, x1, CL + 4, z1, B.PLANKS);
  bp.fill(x0 + 1, CL, z0 + 1, x1 - 1, CL + 4, z1 - 1, B.AIR);
  for (const [cx, cz] of [[x0, z0], [x1 - 1, z0], [x0, z1 - 1], [x1 - 1, z1 - 1]]) bp.fill(cx, CL, cz, cx + 1, CL + 4, cz + 1, B.LOG);
  bp.fill(x0 - 1, CL + 4, z0 - 1, x1 + 1, CL + 5, z1 + 1, B.PLANKS);
  bp.fill(x0, CL + 5, z0, x1, CL + 6, z1, B.PLANKS);
  bp.fill(x0, CL, 60, x0 + 1, CL + 2, 61, B.AIR);
  bp.set(x0, CL + 1, z0 + 2, B.GLASS);
  bp.set(x0 + 2, CL + 3, z0 + 3, B.LAMP);
  bp.fill(x1 - 2, CL, z0 + 1, x1 - 1, CL + 2, z1 - 1, B.BOOKSHELF);
  bp.set(x0 + 2, CL, z0 + 1, B.CRATE);
  // crates, a TNT stash on a pallet, a mine cart with ore, a lantern post, a campfire
  bp.fill(141, CL, 52, 143, CL + 1, 54, B.CRATE);
  bp.set(141, CL + 1, 52, B.CRATE);
  bp.fill(149, CL, 52, 151, CL + 1, 53, B.PLANKS);
  bp.set(149, CL + 1, 52, B.TNT); bp.set(150, CL + 1, 52, B.TNT);
  bp.fill(141, CL, 56, 143, CL + 1, 58, B.METAL);
  bp.set(141, CL + 1, 56, B.COAL_ORE); bp.set(142, CL + 1, 57, B.IRON_ORE);
  bp.feature(feat(F_PARKLAMP, 144, 54, CL, 0, 0, 0));
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) bp.set(148 + dx, CL, 62 + dz, B.COBBLESTONE);
  bp.set(148, CL, 62, B.LOG);
  bp.paint(140, 51, 152, 64, 0x8a837e);
  bp.paint(x0, z0, x1, z1, 0xa8854e, 6, 'roof');
  return bp;
}

/** Beach strip: boardwalk with lamps + benches, lifeguard towers, beach bar. */
export function buildBeach(seed, P) {
  const bx0 = BEACH.boardX0, bx1 = BEACH.boardX1;
  const z0 = BEACH.z0 + 4, z1 = BEACH.z1 - 4;
  const bp = new BP({ id: -3, x0: bx0 - 2, z0, x1: bx1 + 14, z1, seed: 9090 }, seed, P);
  bp.fill(bx0, RY, z0, bx1, RY + 1, z1, B.PLANKS);
  bp.paint(bx0, z0, bx1, z1, 0xb08a52);
  for (let z = z0 + 4; z < z1 - 2; z += 12) {
    bp.feature(feat(F_PARKLAMP, bx0 - 1, z, CL, 0, 0, 0));
    if (z + 6 < z1) { bp.set(bx1, CL - 1, z + 6, B.PLANKS); bp.set(bx1, CL, z + 6, B.PLANKS); }
  }
  // lifeguard towers on the sand
  for (let z = z0 + 30; z < z1 - 10; z += 58) {
    if (Math.abs(z - PIER.z0) < 14) continue;
    const tx = bx1 + 7;
    const g = P.heightAt(tx, z);
    for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [2, 2]]) bp.fill(tx + dx, g, z + dz, tx + dx + 1, CL + 2, z + dz + 1, B.LOG);
    bp.fill(tx - 1, CL + 2, z - 1, tx + 4, CL + 3, z + 4, B.PLANKS);
    bp.fill(tx, CL + 3, z, tx + 3, CL + 5, z + 3, B.WOOL_WHITE);
    bp.fill(tx + 1, CL + 3, z, tx + 3, CL + 5, z + 3, B.AIR);
    bp.fill(tx, CL + 3, z, tx + 1, CL + 5, z + 3, B.WOOL_RED);
    bp.fill(tx - 1, CL + 5, z - 1, tx + 4, CL + 6, z + 4, B.WOOL_RED);
    for (let k = 0; k < 3; k++) bp.set(tx - 1 - k, CL + 1 - k, z + 1, B.PLANKS);
    bp.paint(tx - 1, z - 1, tx + 4, z + 4, 0xb02e26, 6, 'roof');
  }
  // beach bar
  const sx = bx1 + 2, sz = 176;
  bp.fill(sx, RY, sz, sx + 7, RY + 1, sz + 8, B.PLANKS);
  bp.fill(sx, CL, sz, sx + 7, CL + 1, sz + 1, B.PLANKS);
  bp.fill(sx + 6, CL, sz, sx + 7, CL + 1, sz + 8, B.PLANKS);
  for (const [cx, cz] of [[sx, sz], [sx + 6, sz], [sx, sz + 7], [sx + 6, sz + 7]]) bp.fill(cx, CL, cz, cx + 1, CL + 3, cz + 1, B.LOG);
  bp.op(sx - 1, sz - 1, sx + 8, sz + 9, (c) => {
    for (let x = sx - 1; x < sx + 8; x++) for (let z = sz - 1; z < sz + 9; z++) setv(c, x, CL + 3, z, (x + z) % 2 ? B.WOOL_YELLOW : B.WOOL_ORANGE);
  });
  bp.fill(sx + 2, CL + 2, sz, sx + 5, CL + 3, sz + 1, B.NEON_PINK);
  bp.fill(sx + 1, CL, sz + 3, sx + 2, CL + 1, sz + 4, B.WOOL_BLUE);
  bp.fill(sx + 1, CL, sz + 5, sx + 2, CL + 1, sz + 6, B.WOOL_BLUE);
  bp.paint(sx - 1, sz - 1, sx + 8, sz + 9, 0xf9a01d, 4, 'roof');
  return bp;
}

/** Pier from the boardwalk out to sea, with a lighthouse on the end platform. */
export function buildPier(seed, P) {
  const bp = new BP({ id: -4, x0: PIER.x0, z0: PIER.z0 - 6, x1: PIER.x1, z1: PIER.z1 + 6, seed: 5151 }, seed, P);
  const { x0, x1, z0, z1 } = PIER;
  const px0 = x1 - 13, pz0 = z0 - 5, pz1 = z1 + 5;
  bp.fill(x0, RY, z0, x1, RY + 1, z1, B.PLANKS);
  bp.fill(px0, RY, pz0, x1, RY + 1, pz1, B.PLANKS);
  bp.paint(x0, z0, x1, z1, 0xb08a52);
  bp.paint(px0, pz0, x1, pz1, 0xb08a52);
  // pillars down to the sea floor
  bp.op(x0, pz0, x1, pz1, (c) => {
    const pil = (x, z) => {
      const g = P.heightAt(x, z);
      for (let y = Math.max(1, g - 1); y < RY; y++) setv(c, x, y, z, B.LOG);
    };
    for (let x = x0 + 3; x < x1; x += 5) { pil(x, z0); pil(x, z1 - 1); }
    for (let x = px0; x < x1; x += 4) { pil(x, pz0); pil(x, pz1 - 1); }
  });
  // railings + lamps
  bp.op(x0, pz0, x1, pz1, (c) => {
    for (let x = x0 + 6; x < px0; x++) { setv(c, x, CL, z0, B.METAL); setv(c, x, CL, z1 - 1, B.METAL); }
    for (let x = px0; x < x1; x++) { setv(c, x, CL, pz0, B.METAL); setv(c, x, CL, pz1 - 1, B.METAL); }
    for (let z = pz0; z < pz1; z++) setv(c, x1 - 1, CL, z, B.METAL);
    for (let z = pz0; z < z0; z++) setv(c, px0, CL, z, B.METAL);
    for (let z = z1; z < pz1; z++) setv(c, px0, CL, z, B.METAL);
  });
  for (let x = x0 + 10; x < px0; x += 10) { bp.feature(feat(F_LAMP, x, z0, CL, 3, 0, 0)); bp.feature(feat(F_LAMP, x, z1 - 1, CL, 3, 0, 0)); }
  // lighthouse
  const lx = x1 - 6.5, lz = (z0 + z1) / 2;
  const top = CL + 20;
  for (let y = CL; y < top; y += 3) cylinder(bp, lx, lz, 2.7, y, Math.min(top, y + 3), ((y - CL) / 3) % 2 === 0 ? B.WOOL_WHITE : B.WOOL_RED, true, B.AIR);
  cylinder(bp, lx, lz, 3.7, top, top + 1, B.METAL);
  cylinder(bp, lx, lz, 2.2, top + 1, top + 3, B.GLASS);
  bp.fill(Math.floor(lx), top + 1, Math.floor(lz), Math.floor(lx) + 1, top + 3, Math.floor(lz) + 1, B.LAMP);
  cylinder(bp, lx, lz, 2.2, top + 3, top + 4, B.WOOL_RED);
  cylinder(bp, lx, lz, 1.2, top + 4, top + 5, B.WOOL_RED);
  bp.fill(Math.floor(lx) - 2, CL, Math.floor(lz), Math.floor(lx) - 1, CL + 2, Math.floor(lz) + 1, B.AIR);
  // spiral-ish stairs inside the lighthouse
  bp.op(Math.floor(lx) - 2, Math.floor(lz) - 2, Math.floor(lx) + 3, Math.floor(lz) + 3, (c) => {
    const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    for (let k = 0; k < top - CL; k++) {
      const [dx, dz] = ring[k % 8];
      setv(c, Math.floor(lx) + dx, CL + k, Math.floor(lz) + dz, B.PLANKS);
    }
    fillBox(c, Math.floor(lx) - 1, top, Math.floor(lz) - 1, Math.floor(lx) + 2, top + 1, Math.floor(lz) + 2, B.PLANKS);
  });
  bp.paint(Math.floor(lx) - 3, Math.floor(lz) - 3, Math.floor(lx) + 4, Math.floor(lz) + 4, 0xe9ecec, 24, 'roof');
  bp.paint(Math.floor(lx) - 1, Math.floor(lz) - 1, Math.floor(lx) + 2, Math.floor(lz) + 2, 0xb02e26, 25, 'roof');
  return bp;
}

// ------------------------------------------------------------------------------------------------
// Landmarks: hillside "BLOCK CITY" sign, highway billboards, wind turbines, radio mast
// ------------------------------------------------------------------------------------------------
const FONT = {
  B: ['1110', '1001', '1001', '1110', '1001', '1001', '1110'],
  L: ['1000', '1000', '1000', '1000', '1000', '1000', '1111'],
  O: ['0110', '1001', '1001', '1001', '1001', '1001', '0110'],
  C: ['0111', '1000', '1000', '1000', '1000', '1000', '0111'],
  K: ['1001', '1010', '1100', '1000', '1100', '1010', '1001'],
  I: ['111', '010', '010', '010', '010', '010', '111'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

/** Free-standing letters on the mountainside facing the city (letters scaled 2x: 14 tall). */
export function buildHillSign(seed, P) {
  const text = 'BLOCK CITY';
  const S = 2;
  const widths = [...text].map((ch) => (ch === ' ' ? 3 : FONT[ch][0].length * S));
  const total = widths.reduce((a, w) => a + w + 2, 0) - 2;
  const x0 = 252 - (total >> 1);
  // choose the slope row facing the city with the flattest terrain profile (uniform baseline, short scaffolds)
  let zSign = 50, baseY = 50, bestScore = Infinity;
  for (let z = 64; z >= 30; z--) {
    let mn = 1e9, mx = -1e9, sum = 0, n = 0;
    for (let x = x0; x < x0 + total; x++) { const h = P.heightAt(x, z); mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h; n++; }
    if (mx > 64 || mn < 30) continue;
    const score = (mx - mn) + Math.abs(sum / n - 48) * 0.6 + (64 - z) * 0.05;
    if (score < bestScore) { bestScore = score; zSign = z; baseY = mx + 1; }
  }
  const bp = new BP({ id: -5, x0, z0: zSign - 2, x1: x0 + total, z1: zSign + 3, seed: 2024 }, seed, P);
  bp.keepClear([x0 - 3, zSign - 3, x0 + total + 3, zSign + 12]);
  let cx = x0;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k], w = widths[k];
    if (ch !== ' ') {
      const glyph = FONT[ch];
      const base = Math.min(baseY, 78);
      const gw = glyph[0].length;
      const cx0 = cx;
      bp.op(cx0, zSign - 1, cx0 + w, zSign + 2, (c) => {
        for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < gw; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) setv(c, cx0 + gx * S + sx, base + (6 - gy) * S + sy, zSign, B.WOOL_WHITE);
        }
        // scaffold legs behind the letter down to the ground + footlights in front
        for (let x = cx0; x < cx0 + w; x += 2) {
          const g = P.heightAt(x, zSign - 1);
          for (let y = g; y < base + 2; y++) setv(c, x, y, zSign - 1, B.METAL);
          const gf = P.heightAt(x, zSign + 1);
          if (gf <= base) setv(c, x, gf, zSign + 1, B.LAMP);
        }
      });
      bp.paint(cx, zSign, cx + w, zSign + 1, 0xf4f4f4, base + 14 - CL, 'roof');
    }
    cx += w + 2;
  }
  return bp;
}

const ADS = [
  { bg: B.WOOL_YELLOW, fg: B.WOOL_RED, art: ['..........', '.XX..XX...', '.X.X.X.X..', '.XX..XX...', '.X...X....'] },
  { bg: B.WOOL_BLUE, fg: B.WOOL_WHITE, art: ['..........', '..XXXXX...', '.XXXXXXX..', '.X.....X..', '..O...O...'] },
  { bg: B.WOOL_GREEN, fg: B.WOOL_YELLOW, art: ['....XX....', '...XXXX...', '..XXXXXX..', '....XX....', '....XX....'] },
  { bg: B.WOOL_PURPLE, fg: B.NEON_PINK, art: ['..........', '.X.X.XXX..', '.XXX..X...', '.X.X..X...', '..........'] },
  { bg: B.WOOL_WHITE, fg: B.WOOL_BLACK, art: ['.XXXXXXX..', '...XXX....', '....X.....', '....X.....', '...XXX....'] },
];

/** A roadside billboard: two posts + a 10x5 pixel-art board. along = 'x' or 'z' (board plane), at (x, z). */
function billboard(bp, P, x, z, along, ad) {
  const g = Math.max(P.heightAt(x, z), P.heightAt(along === 'x' ? x + 9 : x, along === 'x' ? z : z + 9));
  const y0 = g + 5;
  for (const k of [1, 8]) {
    const px = along === 'x' ? x + k : x, pz = along === 'x' ? z : z + k;
    bp.fill(px, Math.min(P.heightAt(px, pz), g), pz, px + 1, y0, pz + 1, B.METAL);
  }
  bp.op(x - 1, z - 1, x + 12, z + 12, (c) => {
    for (let r = 0; r < 7; r++) for (let k = 0; k < 12; k++) {
      const frame = r === 0 || r === 6 || k === 0 || k === 11;
      let id = frame ? B.WOOL_BLACK : ad.bg;
      if (!frame) { const ch = ad.art[r - 1][k - 1]; if (ch === 'X') id = ad.fg; else if (ch === 'O') id = B.WOOL_BLACK; }
      const px = along === 'x' ? x - 1 + k : x, pz = along === 'x' ? z : z - 1 + k;
      setv(c, px, y0 + 6 - r, pz, id);
    }
    // catwalk + lights
    for (let k = 0; k < 12; k++) {
      const px = along === 'x' ? x - 1 + k : x, pz = along === 'x' ? z : z - 1 + k;
      if (k % 4 === 1) setv(c, px, y0 - 1, pz, B.LAMP);
    }
  });
}

export function buildBillboards(seed, P) {
  const spots = [
    { x: 414, z: 128, along: 'z' }, { x: 84, z: 150, along: 'z' }, { x: 230, z: 448, along: 'x' }, { x: 300, z: 82, along: 'x' },
    { x: 414, z: 268, along: 'z' }, { x: 84, z: 380, along: 'z' },
  ];
  const bp = new BP({ id: -6, x0: 80, z0: 80, x1: 420, z1: 460, seed: 777 }, seed, P);
  spots.forEach((s, k) => {
    let ok = true;
    for (let d = -1; d < 12 && ok; d++) {
      const px = s.along === 'x' ? s.x + d : s.x, pz = s.along === 'x' ? s.z : s.z + d;
      if (P.isRoad(px, pz) || P.isSidewalk(px, pz) || P.isCityOrLot(px, pz) || P.heightAt(px, pz) < 25) ok = false;
    }
    if (ok) billboard(bp, P, s.x, s.z, s.along, ADS[k % ADS.length]);
  });
  bp.bbox = [79, 79, 430, 470];
  return bp;
}

/** Three wind turbines on the southern hills. */
export function buildTurbines(seed, P) {
  const bp = new BP({ id: -7, x0: 300, z0: 444, x1: 430, z1: 486, seed: 31337 }, seed, P);
  const sites = [[318, 462], [350, 468], [382, 460], [412, 470]];
  for (const [x, z] of sites) {
    const g = P.heightAt(x, z);
    if (g < 25 || P.isRoad(x, z) || P.isCityOrLot(x, z)) continue;
    const top = Math.min(g + 22, 86);
    bp.fill(x, g - 1, z, x + 1, top, z + 1, B.WOOL_WHITE);
    bp.fill(x - 1, g - 1, z - 1, x + 2, g, z + 2, B.CONCRETE);
    bp.fill(x, top, z - 1, x + 1, top + 1, z + 2, B.WOOL_WHITE);
    const hub = [x, top, z - 2];
    bp.op(x - 9, z - 3, x + 10, z, (c) => {
      setv(c, hub[0], hub[1], hub[2], B.METAL);
      const ang = ((x * 7 + z) % 360) * Math.PI / 180;
      for (let b = 0; b < 3; b++) {
        const a = ang + b * (Math.PI * 2 / 3);
        for (let r = 1; r <= 8; r++) setv(c, Math.round(hub[0] + Math.cos(a) * r), Math.round(hub[1] + Math.sin(a) * r), hub[2], B.WOOL_WHITE);
      }
    });
    bp.paint(x - 1, z - 1, x + 2, z + 2, 0xf0f0f0, top - CL, 'roof');
  }
  return bp;
}

/** Radio mast with blinking-red-style lights on the highest peak of the range. */
export function buildRadioMast(seed, P) {
  let best = 0, bx = 260, bz = 40;
  for (let z = 26; z < 62; z += 2) for (let x = 220; x < 330; x += 2) { const h = P.heightAt(x, z); if (h > best) { best = h; bx = x; bz = z; } }
  const bp = new BP({ id: -8, x0: bx - 3, z0: bz - 3, x1: bx + 4, z1: bz + 4, seed: 99 }, seed, P);
  const g = best;
  bp.fill(bx - 2, g, bz - 2, bx + 3, g + 3, bz + 3, B.CONCRETE);
  bp.fill(bx - 1, g, bz + 2, bx, g + 2, bz + 3, B.AIR);
  const top = Math.min(95, g + 3 + 18);
  bp.op(bx - 1, bz - 1, bx + 2, bz + 2, (c) => {
    for (let y = g + 3; y < top; y++) {
      const lattice = (y % 2) === 0;
      setv(c, bx, y, bz, B.METAL);
      if (lattice) { setv(c, bx - 1, y, bz, B.METAL); setv(c, bx + 1, y, bz, B.METAL); setv(c, bx, y, bz - 1, B.METAL); setv(c, bx, y, bz + 1, B.METAL); }
    }
    setv(c, bx, top, bz, B.NEON_PINK);
    setv(c, bx + 1, g + 12, bz, B.NEON_PINK); setv(c, bx - 1, g + 12, bz, B.NEON_PINK);
  });
  bp.paint(bx - 2, bz - 2, bx + 3, bz + 3, 0xb9b9b4, 3, 'roof');
  return bp;
}
