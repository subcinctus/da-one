// Non-building lots: central park, pocket park, plazas, market, parking lots, industrial yards, the port, the farm.
import { B } from './blocks.js';
import { CL, RY, h3, CONTAINER_COLORS } from './gen_const.js';
import { Frame, helipad, cylinder, fillBox, setv, roofDetails } from './gen_build_core.js';
import { buildHouse } from './gen_build_city.js';
import { feat, F_OAK, F_BIGOAK, F_PARKLAMP, F_HAYBALE, F_LAMP } from './gen_features.js';

const pick = (rng, a) => a[Math.floor(rng() * a.length)];

// ------------------------------------------------------------------------------------------------
// Parks
// ------------------------------------------------------------------------------------------------
export function buildCentralPark(bp) {
  const L = bp.lot;
  const cx = (L.x0 + L.x1) / 2, cz = (L.z0 + L.z1) / 2; // 212, 212
  const pond = { x: cx + 15.5, z: cz - 15, rx: 7.5, rz: 6 };
  const ringR = 15;
  const kind = new Uint8Array((L.x1 - L.x0) * (L.z1 - L.z0)); // 0 grass 1 path 2 pond 3 fountain-rim 4 fountain-water 5 plaza 6 hedge 7 sand
  const W = L.x1 - L.x0;
  for (let z = L.z0; z < L.z1; z++) {
    for (let x = L.x0; x < L.x1; x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      const d = Math.hypot(dx, dz);
      let k = 0;
      const pd = Math.hypot((x + 0.5 - pond.x) / pond.rx, (z + 0.5 - pond.z) / pond.rz);
      if (Math.abs(dx) < 1.6 || Math.abs(dz) < 1.6) k = 1;
      if (Math.abs(d - ringR) < 1.5) k = 1;
      if (d > ringR && Math.abs(Math.abs(dx) - Math.abs(dz)) < 1.3 && !(dx > 0 && dz < 0)) k = 1;
      if (d < 8.5) k = 5;
      if (d < 5.5) k = 3;
      if (d < 4.5) k = 4;
      if (pd < 1) k = 2;
      else if (pd < 1.25 && k === 0) k = 7;
      const edge = x === L.x0 || z === L.z0 || x === L.x1 - 1 || z === L.z1 - 1;
      if (edge && k !== 1) k = 6;
      kind[(z - L.z0) * W + (x - L.x0)] = k;
    }
  }
  const kAt = (x, z) => (x < L.x0 || z < L.z0 || x >= L.x1 || z >= L.z1 ? 9 : kind[(z - L.z0) * W + (x - L.x0)]);
  for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) { const k = kAt(x, z); if (k === 2 || k === 4) bp.wet(x, z, x + 1, z + 1); }
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    const x0 = Math.max(L.x0, c.ox), x1 = Math.min(L.x1, c.ox + 16), z0 = Math.max(L.z0, c.oz), z1 = Math.min(L.z1, c.oz + 16);
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const k = kAt(x, z);
        const hh = h3(x, 7, z, 91);
        switch (k) {
          case 0: setv(c, x, RY, z, B.GRASS);
            if (hh < 0.06) setv(c, x, CL, z, hh < 0.02 ? B.FLOWER_RED : hh < 0.04 ? B.FLOWER_YELLOW : B.TALL_GRASS);
            break;
          case 1: setv(c, x, RY, z, B.GRAVEL); break;
          case 2: {
            const pd = Math.hypot((x + 0.5 - pond.x) / pond.rx, (z + 0.5 - pond.z) / pond.rz);
            const depth = pd < 0.5 ? 4 : pd < 0.8 ? 3 : 2;
            for (let y = RY - depth; y <= RY; y++) setv(c, x, y, z, B.WATER);
            setv(c, x, RY - depth - 1, z, pd < 0.6 ? B.GRAVEL : B.SAND);
            break;
          }
          case 7: setv(c, x, RY, z, B.SAND); if (hh < 0.35) setv(c, x, CL, z, B.TALL_GRASS); break;
          case 3: setv(c, x, RY, z, B.MARBLE); setv(c, x, CL, z, B.MARBLE); break;
          case 4: setv(c, x, RY - 1, z, B.MARBLE); setv(c, x, RY, z, B.WATER); break;
          case 5: setv(c, x, RY, z, (x + z) % 2 === 0 ? B.MARBLE : B.TILE_WHITE); break;
          case 6: setv(c, x, RY, z, B.GRASS); setv(c, x, CL, z, B.HEDGE); break;
          default: break;
        }
      }
    }
  });
  // fountain centre column with a water spout
  const fx = Math.floor(cx), fz = Math.floor(cz);
  bp.fill(fx - 1, RY, fz - 1, fx + 1, CL + 2, fz + 1, B.MARBLE);
  bp.fill(fx - 1, CL + 2, fz - 1, fx + 1, CL + 3, fz + 1, B.WATER);
  bp.set(fx - 1, CL + 3, fz - 1, B.WATER);
  bp.set(fx, CL + 3, fz, B.WATER);
  for (const [ax, az] of [[-6, -6], [5, -6], [-6, 5], [5, 5]]) bp.feature(feat(F_PARKLAMP, fx + ax, fz + az, CL, 0, 0, 0));
  // wooden jetty into the pond
  const jx = Math.floor(pond.x - pond.rx) - 1, jz = Math.floor(pond.z);
  bp.fill(jx, RY, jz, jx + 5, RY + 1, jz + 2, B.PLANKS);
  bp.set(jx + 4, CL, jz, B.LOG);
  // trees on a jittered grid (avoid paths / water / fountain)
  for (let gz = L.z0 + 2; gz < L.z1 - 2; gz += 5) {
    for (let gx = L.x0 + 2; gx < L.x1 - 2; gx += 5) {
      const tx = gx + Math.floor(h3(gx, 1, gz, 5) * 4), tz = gz + Math.floor(h3(gx, 2, gz, 5) * 4);
      if (tx >= L.x1 - 2 || tz >= L.z1 - 2) continue;
      let ok = true;
      for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2 && ok; dx++) { const k = kAt(tx + dx, tz + dz); if (k !== 0 && k !== 6) ok = false; }
      if (!ok || h3(tx, 3, tz, 5) < 0.3) continue;
      const big = h3(tx, 4, tz, 5) < 0.3;
      bp.feature(feat(big ? F_BIGOAK : F_OAK, tx, tz, CL, big ? 6 : 4 + Math.floor(h3(tx, 5, tz, 5) * 2), big ? 3 : 2, big ? 3 : 2));
      bp.paint(tx - (big ? 3 : 2), tz - (big ? 3 : 2), tx + (big ? 4 : 3), tz + (big ? 4 : 3), 0x2f6a24, 0, 'tree');
    }
  }
  // benches + lamps along the ring path
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2 + 0.13;
    const bx = Math.floor(cx + Math.cos(ang) * (ringR + 2.2)), bz = Math.floor(cz + Math.sin(ang) * (ringR + 2.2));
    if (kAt(bx, bz) !== 0) continue;
    if (a % 3 === 0) bp.feature(feat(F_PARKLAMP, bx, bz, CL, 0, 0, 0));
    else bp.set(bx, CL, bz, B.PLANKS);
  }
  // playground in the south-west quadrant
  const px = L.x0 + 5, pz = L.z1 - 13;
  bp.fill(px, RY, pz, px + 8, RY + 1, pz + 8, B.SAND);
  bp.fill(px + 1, CL, pz + 1, px + 2, CL + 3, pz + 2, B.WOOL_BLUE);
  bp.fill(px + 1, CL + 3, pz + 1, px + 3, CL + 4, pz + 3, B.WOOL_RED);
  for (let k = 0; k < 3; k++) bp.set(px + 3 + k, CL + 2 - k, pz + 2, B.WOOL_YELLOW);
  bp.fill(px + 5, CL, pz + 5, px + 6, CL + 3, pz + 6, B.METAL);
  bp.fill(px + 7, CL, pz + 5, px + 8, CL + 3, pz + 6, B.METAL);
  bp.fill(px + 5, CL + 3, pz + 5, px + 8, CL + 4, pz + 6, B.METAL);
  // map paint
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x62a83e);
  bp.mapFn = (put) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) {
      const k = kAt(x, z);
      const col = k === 1 ? 0xc2b49a : k === 2 ? 0x3d86d6 : k === 3 || k === 5 ? 0xe8e4dc : k === 4 ? 0x5aa8e8 : k === 6 ? 0x2f6b25 : k === 7 ? 0xdbcf8f : 0;
      if (col) put(x, z, col);
    }
  };
}

export function buildPocketPark(bp) {
  const L = bp.lot, rng = bp.rng;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.GRASS);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x62a83e);
  // gravel paths (diagonal-ish cross)
  const cx = (L.x0 + L.x1) >> 1, cz = (L.z0 + L.z1) >> 1;
  bp.fill(cx - 1, RY, L.z0, cx + 1, RY + 1, L.z1, B.GRAVEL);
  bp.fill(L.x0, RY, cz - 1, L.x1, RY + 1, cz + 1, B.GRAVEL);
  bp.paint(cx - 1, L.z0, cx + 1, L.z1, 0xc2b49a);
  bp.paint(L.x0, cz - 1, L.x1, cz + 1, 0xc2b49a);
  // basketball court in one quadrant
  const q = [L.x0 + 1, L.z0 + 1, cx - 2, cz - 2];
  bp.fill(q[0], RY, q[1], q[2], RY + 1, q[3], B.CONCRETE_DARK);
  bp.paint(q[0], q[1], q[2], q[3], 0x6a6a70);
  bp.op(q[0], q[1], q[2], q[3], (c) => {
    for (let x = q[0]; x < q[2]; x++) { setv(c, x, RY, q[1], B.ROAD_LINE_WHITE); setv(c, x, RY, q[3] - 1, B.ROAD_LINE_WHITE); }
    for (let z = q[1]; z < q[3]; z++) { setv(c, q[0], RY, z, B.ROAD_LINE_WHITE); setv(c, q[2] - 1, RY, z, B.ROAD_LINE_WHITE); }
  });
  const hx = (q[0] + q[2]) >> 1;
  bp.fill(hx, CL, q[1], hx + 1, CL + 4, q[1] + 1, B.METAL);
  bp.set(hx, CL + 3, q[1] + 1, B.WOOL_ORANGE);
  // playground in another
  const p = [cx + 2, L.z0 + 2, L.x1 - 2, cz - 2];
  bp.fill(p[0], RY, p[1], p[2], RY + 1, p[3], B.SAND);
  bp.paint(p[0], p[1], p[2], p[3], 0xdbcf8f);
  bp.fill(p[0] + 1, CL, p[1] + 1, p[0] + 2, CL + 3, p[1] + 2, B.WOOL_YELLOW);
  bp.fill(p[0] + 1, CL + 3, p[1] + 1, p[0] + 3, CL + 4, p[1] + 3, B.WOOL_RED);
  for (let k = 0; k < 3; k++) bp.set(p[0] + 3 + k, CL + 2 - k, p[1] + 2, B.WOOL_BLUE);
  // trees + benches + lamp
  for (const [tx, tz] of [[L.x0 + 4, L.z1 - 4], [L.x1 - 4, L.z1 - 5], [L.x0 + 3, cz + 4], [cx + 4, L.z1 - 3]]) {
    bp.feature(feat(rng() < 0.5 ? F_OAK : F_BIGOAK, tx, tz, CL, 5, 2, 3));
    bp.paint(tx - 2, tz - 2, tx + 3, tz + 3, 0x2f6a24, 0, 'tree');
  }
  bp.set(cx + 2, CL, cz + 2, B.PLANKS); bp.set(cx - 3, CL, cz + 2, B.PLANKS);
  bp.feature(feat(F_PARKLAMP, cx + 2, cz - 3, CL, 0, 0, 0));
  bp.feature(feat(F_PARKLAMP, cx - 3, cz + 4, CL, 0, 0, 0));
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) {
      const edge = x === L.x0 || z === L.z0 || x === L.x1 - 1 || z === L.z1 - 1;
      if (edge && Math.abs(x - cx + 0.5) > 1.5 && Math.abs(z - cz + 0.5) > 1.5) setv(c, x, CL, z, B.HEDGE);
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Plazas
// ------------------------------------------------------------------------------------------------
export function buildPlaza(bp) {
  const L = bp.lot, rng = bp.rng;
  const cx = (L.x0 + L.x1) / 2, cz = (L.z0 + L.z1) / 2;
  const pa = rng() < 0.5 ? B.MARBLE : B.TILE_WHITE, pb = pa === B.MARBLE ? B.SANDSTONE : B.CONCRETE;
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) {
      const d = Math.max(Math.abs(x + 0.5 - cx), Math.abs(z + 0.5 - cz));
      setv(c, x, RY, z, Math.floor(d) % 3 === 0 ? pb : pa);
    }
  });
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0xded8cc);
  const fx = Math.floor(cx), fz = Math.floor(cz);
  if (L.style === 'plaza' && rng() < 0.5) {
    // modern sculpture: three stacked tilted cubes
    bp.fill(fx - 2, CL, fz - 2, fx + 2, CL + 1, fz + 2, B.MARBLE);
    bp.fill(fx - 2, CL + 1, fz - 2, fx + 1, CL + 4, fz + 1, B.WOOL_RED);
    bp.fill(fx - 1, CL + 4, fz - 1, fx + 2, CL + 7, fz + 2, B.WOOL_YELLOW);
    bp.fill(fx - 2, CL + 7, fz, fx + 1, CL + 10, fz + 3, B.WOOL_BLUE);
    bp.paint(fx - 2, fz - 2, fx + 2, fz + 3, 0xd8b030, 10, 'roof');
  } else {
    // fountain
    cylinder(bp, cx, cz, 4.5, CL, CL + 1, B.MARBLE, true, B.WATER);
    cylinder(bp, cx, cz, 3.5, RY, RY + 1, B.WATER);
    for (let z = fz - 4; z <= fz + 4; z++) for (let x = fx - 4; x <= fx + 4; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < 3.5) bp.wet(x, z, x + 1, z + 1);
    bp.fill(fx - 1, CL, fz - 1, fx + 1, CL + 3, fz + 1, B.MARBLE);
    bp.fill(fx - 1, CL + 3, fz - 1, fx + 1, CL + 4, fz + 1, B.WATER);
    bp.paint(fx - 4, fz - 4, fx + 5, fz + 5, 0x5aa8e8);
  }
  // planter trees in the corners, benches, lamps
  for (const [ax, az] of [[3, 3], [-4, 3], [3, -4], [-4, -4]]) {
    const tx = ax > 0 ? L.x0 + ax : L.x1 + ax, tz = az > 0 ? L.z0 + az : L.z1 + az;
    bp.fill(tx - 1, CL, tz - 1, tx + 2, CL + 1, tz + 2, B.HEDGE);
    bp.set(tx, CL, tz, B.GRASS);
    bp.feature(feat(F_OAK, tx, tz, CL + 1, 4, 2, 3));
    bp.paint(tx - 2, tz - 2, tx + 3, tz + 3, 0x2f6a24, 0, 'tree');
  }
  for (const [bx, bz] of [[fx - 6, fz], [fx + 6, fz], [fx, fz - 6], [fx, fz + 6]]) bp.set(bx, CL, bz, B.PLANKS);
  for (const [lx, lz] of [[fx - 6, fz - 6], [fx + 6, fz + 6], [fx - 6, fz + 6], [fx + 6, fz - 6]]) bp.feature(feat(F_PARKLAMP, lx, lz, CL, 0, 0, 0));
}

export function buildMarket(bp) {
  const L = bp.lot, rng = bp.rng;
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) setv(c, x, RY, z, h3(x, 0, z, 4) < 0.5 ? B.COBBLESTONE : B.GRAVEL);
  });
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x9a9488);
  // two rows of stalls with striped awnings
  for (let row = 0; row < 2; row++) {
    const sz = L.z0 + 3 + row * 9;
    for (let k = 0; k < 4; k++) {
      const sx = L.x0 + 2 + k * 4;
      if (sx + 3 > L.x1 - 1) break;
      const aw = pick(rng, [[B.WOOL_RED, B.WOOL_WHITE], [B.WOOL_GREEN, B.WOOL_WHITE], [B.WOOL_BLUE, B.WOOL_YELLOW], [B.WOOL_ORANGE, B.WOOL_WHITE], [B.WOOL_PURPLE, B.WOOL_WHITE]]);
      bp.fill(sx, CL, sz, sx + 3, CL + 1, sz + 1, B.PLANKS);
      bp.set(sx, CL, sz + 2, B.LOG); bp.set(sx + 2, CL, sz + 2, B.LOG);
      bp.fill(sx, CL + 1, sz + 2, sx + 1, CL + 3, sz + 3, B.LOG);
      bp.fill(sx + 2, CL + 1, sz + 2, sx + 3, CL + 3, sz + 3, B.LOG);
      bp.fill(sx, CL, sz - 0, sx + 1, CL + 3, sz + 1, B.LOG);
      bp.fill(sx + 2, CL, sz, sx + 3, CL + 3, sz + 1, B.LOG);
      bp.op(sx, sz, sx + 3, sz + 3, (c) => { for (let x = sx; x < sx + 3; x++) for (let z = sz; z < sz + 3; z++) setv(c, x, CL + 3, z, (x + z) % 2 ? aw[0] : aw[1]); });
      bp.set(sx + 1, CL + 1, sz, pick(rng, [B.CRATE, B.FLOWER_RED, B.FLOWER_YELLOW, B.WOOL_YELLOW, B.LEAVES]));
      bp.paint(sx, sz, sx + 3, sz + 3, aw[0] === B.WOOL_RED ? 0xb02e26 : aw[0] === B.WOOL_GREEN ? 0x5e7c16 : aw[0] === B.WOOL_BLUE ? 0x3c44aa : aw[0] === B.WOOL_ORANGE ? 0xf9801d : 0x8932b8, 3, 'roof');
    }
  }
  const cx = (L.x0 + L.x1) >> 1, cz = L.z1 - 3;
  bp.feature(feat(F_OAK, cx, cz, CL, 5, 2, 3));
  bp.feature(feat(F_PARKLAMP, L.x0 + 1, L.z1 - 2, CL, 0, 0, 0));
  bp.feature(feat(F_PARKLAMP, L.x1 - 2, L.z1 - 2, CL, 0, 0, 0));
}

// ------------------------------------------------------------------------------------------------
// Construction site (empty plot for builder missions) with a tower crane
// ------------------------------------------------------------------------------------------------
export function buildSite(bp) {
  const L = bp.lot, rng = bp.rng;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) setv(c, x, RY, z, h3(x, 4, z, 12) < 0.3 ? B.GRAVEL : B.DIRT);
  });
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x8a6a44);
  // fence: metal posts + hazard panels, gate on the front
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    const put = (u, v) => {
      const x = F.x(u, v), z = F.z(u, v);
      const post = (u + v) % 3 === 0;
      setv(c, x, CL, z, post ? B.METAL : B.HAZARD);
      setv(c, x, CL + 1, z, post ? B.METAL : B.WOOL_ORANGE);
    };
    for (let u = 0; u < W; u++) { if (u < 7 || u > 12) put(u, 0); put(u, D - 1); }
    for (let v = 1; v < D - 1; v++) { put(0, v); put(W - 1, v); }
  });
  bp.keepClear(F.rect(6, -3, 14, 0));
  // tower crane in the back corner
  const mx = F.x(2, D - 4), mz = F.z(2, D - 4);
  const top = 74;
  bp.op(mx - 1, mz - 1, mx + 2, mz + 2, (c) => {
    for (let y = CL; y < top; y++) {
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const lattice = (y + dx + dz) % 3 !== 0;
        setv(c, mx + dx - 0, y, mz + dz - 0, lattice ? B.METAL : B.AIR);
      }
    }
  });
  bp.fill(mx - 1, top, mz - 1, mx + 3, top + 1, mz + 3, B.METAL);
  bp.fill(mx, top + 1, mz, mx + 2, top + 3, mz + 2, B.WOOL_YELLOW);
  bp.fill(mx, top + 2, mz, mx + 2, top + 3, mz + 1, B.GLASS);
  // jib along the lot diagonal axis (u direction), counter-jib with concrete weights
  const jy = top + 3;
  const ja = F.rect(-6, D - 4, W + 6, D - 3);
  bp.fillR(ja, jy, jy + 1, B.WOOL_YELLOW);
  const cw = F.rect(-6, D - 4, -3, D - 3);
  bp.fillR(cw, jy - 2, jy, B.CONCRETE_DARK);
  bp.fill(mx, jy + 1, mz, mx + 1, jy + 4, mz + 1, B.METAL);
  // hook with a pallet of bricks hanging over the site
  const hx = F.x(W - 6, D - 4), hz = F.z(W - 6, D - 4);
  bp.fill(hx, 52, hz, hx + 1, jy, hz + 1, B.METAL);
  bp.fill(hx - 1, 50, hz - 1, hx + 2, 52, hz + 2, B.BRICK);
  bp.paintR(ja, 0xd9b026, jy - CL, 'roof');
  // material pallets, mixer, site office container, portable toilets
  const pal = [B.PLANKS, B.BRICK, B.CONCRETE, B.COBBLESTONE, B.GLASS];
  for (let k = 0; k < 5; k++) {
    const u = 3 + k * 3, v = 3;
    bp.fillR(F.rect(u, v, u + 2, v + 2), CL, CL + 1 + (k % 2), pal[k]);
  }
  bp.fillR(F.rect(W - 5, 4, W - 2, 10), CL, CL + 3, B.WOOL_WHITE);
  bp.fillR(F.rect(W - 5, 5, W - 4, 9), CL + 1, CL + 2, B.WINDOW);
  bp.fillR(F.rect(W - 5, 4, W - 2, 10), CL + 3, CL + 4, B.METAL);
  bp.paintR(F.rect(W - 5, 4, W - 2, 10), 0xe9ecec, 4, 'roof');
  for (let k = 0; k < 2; k++) bp.fillR(F.rect(W - 3, 12 + k * 2, W - 2, 13 + k * 2), CL, CL + 2, B.WOOL_BLUE);
  const mxr = F.rect(6, D - 7, 8, D - 5);
  bp.fillR(mxr, CL, CL + 1, B.METAL);
  bp.fillR(mxr, CL + 1, CL + 2, B.WOOL_ORANGE);
  void rng;
}

// ------------------------------------------------------------------------------------------------
// Parking lot
// ------------------------------------------------------------------------------------------------
export function buildParking(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.ASPHALT);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x4d4d52);
  // back row (nose-in, facing the back) and front row with an entrance gap
  const bays = Math.floor((W - 2) / 3);
  const u0 = Math.floor((W - bays * 3) / 2);
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let b = 0; b <= bays; b++) {
      const u = u0 + b * 3;
      for (let v = D - 6; v < D - 1; v++) setv(c, F.x(u, v), RY, F.z(u, v), B.ROAD_LINE_WHITE);
      if (u < (W >> 1) - 3 || u > (W >> 1) + 3) for (let v = 1; v < 6; v++) setv(c, F.x(u, v), RY, F.z(u, v), B.ROAD_LINE_WHITE);
    }
    // perimeter hedge (front gap = entrance)
    for (let u = 0; u < W; u++) {
      if (Math.abs(u + 0.5 - W / 2) > 4) setv(c, F.x(u, 0), CL, F.z(u, 0), B.HEDGE);
      setv(c, F.x(u, D - 1), CL, F.z(u, D - 1), B.HEDGE);
    }
    for (let v = 0; v < D; v++) { setv(c, F.x(0, v), CL, F.z(0, v), B.HEDGE); setv(c, F.x(W - 1, v), CL, F.z(W - 1, v), B.HEDGE); }
    // arrows on the aisle
    for (let v = 7; v < D - 7; v++) setv(c, F.x(W >> 1, v), RY, F.z(W >> 1, v), v % 3 === 0 ? B.ROAD_LINE_YELLOW : B.ASPHALT);
  });
  for (let b = 0; b < bays; b++) {
    const uc = u0 + b * 3 + 1.5;
    bp.spot(F.px(uc + 0, D - 3.6), F.pz(uc, D - 3.6), F.yawIn, 'lot');
    if (uc < (W >> 1) - 3 || uc > (W >> 1) + 3) bp.spot(F.px(uc, 3.4), F.pz(uc, 3.4), F.yawOut, 'lot');
  }
  bp.mapFn = (put) => {
    for (let b = 0; b <= bays; b++) {
      const u = u0 + b * 3;
      for (let v = D - 6; v < D - 1; v++) put(F.x(u, v), F.z(u, v), 0xb8b8bc);
      if (u < (W >> 1) - 3 || u > (W >> 1) + 3) for (let v = 1; v < 6; v++) put(F.x(u, v), F.z(u, v), 0xb8b8bc);
    }
  };
  // pay booth + lamps
  bp.fillR(F.rect(1, 1, 3, 3), CL, CL + 3, B.WOOL_YELLOW);
  bp.fillR(F.rect(1, 1, 3, 3), CL + 3, CL + 4, B.CONCRETE_DARK);
  bp.set(F.x(2, 1), CL + 1, F.z(2, 1), B.GLASS);
  bp.feature(feat(F_LAMP, F.x(W >> 1, D - 2), F.z(W >> 1, D - 2), CL, 5, 0, 0));
  bp.keepClear(F.rect((W >> 1) - 4, -3, (W >> 1) + 4, 0));
}

// ------------------------------------------------------------------------------------------------
// Industrial
// ------------------------------------------------------------------------------------------------
function containerStack(bp, x0, z0, alongX, len, levels, salt) {
  for (let lv = 0; lv < levels; lv++) {
    const col = CONTAINER_COLORS[Math.floor(h3(x0, lv, z0, salt) * CONTAINER_COLORS.length)];
    const y = CL + lv * 3;
    const x1 = alongX ? x0 + len : x0 + 3, z1 = alongX ? z0 + 3 : z0 + len;
    bp.op(x0, z0, x1, z1, (c) => {
      for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) for (let yy = y; yy < y + 3; yy++) {
        const end = alongX ? (x === x0 || x === x1 - 1) : (z === z0 || z === z1 - 1);
        const rib = alongX ? (x - x0) % 2 === 0 : (z - z0) % 2 === 0;
        setv(c, x, yy, z, end ? B.METAL : (rib && yy === y + 1 ? shadeWool(col) : col));
      }
    });
  }
  return CONTAINER_COLORS[Math.floor(h3(x0, levels - 1, z0, salt) * CONTAINER_COLORS.length)];
}
function shadeWool(id) { return id === B.WOOL_WHITE ? B.CONCRETE : id; }

const WOOL_MAP = new Map([[B.WOOL_RED, 0xb02e26], [B.WOOL_BLUE, 0x3c44aa], [B.WOOL_GREEN, 0x5e7c16], [B.WOOL_ORANGE, 0xf9801d], [B.WOOL_YELLOW, 0xfed83d], [B.WOOL_WHITE, 0xe9ecec], [B.WOOL_PURPLE, 0x8932b8]]);

export function buildWarehouse(bp) {
  const L = bp.lot, rng = bp.rng;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE_DARK);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x707176);
  const yardD = Math.min(7, Math.floor(D * 0.35));
  const top = CL + Math.max(10, Math.min(16, Math.round(L.height / 2) * 2));
  const r = F.rect(1, yardD, W - 1, D - 1);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  const wall = pick(rng, [B.METAL, B.CONCRETE_DARK, B.BRICK]);
  bp.facade(box, { wall, corner: B.CONCRETE_DARK, band: 0, win: wall === B.METAL ? B.CONCRETE_DARK : B.METAL, lit: B.WINDOW_LIT, litP: 0, fh: 1, rows: 1, per: 4, mask: 0b0001, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.CONCRETE_DARK, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], wall === B.BRICK ? 0x8a4a3a : 0x8c949a, top - CL, 'roof');
  // hollow hall with lamps and crate stacks
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    fillBox(c, r[0] + 1, CL, r[1] + 1, r[2] - 1, top - 1, r[3] - 1, B.AIR);
    for (let x = r[0] + 3; x < r[2] - 2; x += 5) for (let z = r[1] + 3; z < r[3] - 2; z += 5) setv(c, x, top - 2, z, B.LAMP);
    for (let z = r[1] + 2; z < r[3] - 2; z++) for (let x = r[0] + 2; x < r[2] - 2; x++) {
      const hh = h3(x >> 1, 1, z >> 1, L.seed & 0xffff);
      if ((x >> 1) % 3 === 0 && hh < 0.55) {
        const hgt = 1 + Math.floor(hh * 5);
        for (let y = CL; y < CL + hgt; y++) setv(c, x, y, z, B.CRATE);
      }
    }
  });
  // high window band
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    const y = top - 3;
    for (let x = r[0] + 1; x < r[2] - 1; x++) { if (x % 2) { setv(c, x, y, r[1], B.WINDOW); setv(c, x, y, r[3] - 1, B.WINDOW); } }
    for (let z = r[1] + 1; z < r[3] - 1; z++) { if (z % 2) { setv(c, r[0], y, z, B.WINDOW); setv(c, r[2] - 1, y, z, B.WINDOW); } }
  });
  // loading doors on the yard side (open)
  const doors = Math.max(1, Math.floor((W - 4) / 12));
  for (let k = 0; k < doors; k++) {
    const u = 4 + k * Math.floor((W - 8) / doors);
    bp.fillR(F.rect(u, yardD, u + 5, yardD + 1), CL, CL + 5, B.AIR);
    bp.fillR(F.rect(u - 1, yardD, u, yardD + 1), CL, CL + 6, B.HAZARD);
    bp.fillR(F.rect(u + 5, yardD, u + 6, yardD + 1), CL, CL + 6, B.HAZARD);
    bp.fillR(F.rect(u - 1, yardD, u + 6, yardD + 1), CL + 5, CL + 6, B.HAZARD);
    bp.fillR(F.rect(u, yardD - 3, u + 5, yardD), RY, RY + 1, B.CONCRETE);
    if (k % 2 === 0) bp.spot(F.px(u + 2.5, yardD - 2.5), F.pz(u + 2.5, yardD - 2.5), F.yawIn, 'truck');
  }
  // sawtooth skylights
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    for (let x = r[0] + 2; x < r[2] - 2; x++) for (let z = r[1] + 2; z < r[3] - 2; z++) {
      if (((F.face === 0 || F.face === 2) ? (z - r[1]) : (x - r[0])) % 4 === 0) { setv(c, x, top - 1, z, B.GLASS); setv(c, x, top, z, B.ROOF); }
    }
  });
  roofDetails(bp, r, top, ['vent', 'ac', 'vent'], null);
  // yard: crate piles + forklift-ish
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let v = 1; v < yardD - 1; v++) for (let u = 1; u < W - 1; u++) {
      const x = F.x(u, v), z = F.z(u, v);
      const hh = h3(x, 2, z, 61);
      if (u % 12 > 8 && hh < 0.6) { setv(c, x, CL, z, B.CRATE); if (hh < 0.25) setv(c, x, CL + 1, z, B.CRATE); }
    }
    // entrance gate posts + yellow lane
    for (let u = 0; u < W; u++) if (u % 2 === 0) setv(c, F.x(u, 0), RY, F.z(u, 0), B.ROAD_LINE_YELLOW);
  });
  bp.keepClear(F.rect(2, -3, W - 2, 0));
  bp.roofY = top;
}

export function buildFactory(bp) {
  const L = bp.lot, rng = bp.rng;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE_DARK);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x6a6b70);
  const top = CL + 12;
  // main shed (left 60%)
  const sw = Math.floor(W * 0.6);
  const r = F.rect(1, 2, sw, D - 1);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.facade(box, { wall: B.BRICK, corner: B.CONCRETE_DARK, band: B.CONCRETE_DARK, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.5, fh: 4, rows: 0b0110, per: 3, mask: 0b011, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.CONCRETE_DARK, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], 0x7c4034, top - CL, 'roof');
  // sawtooth roof teeth
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    for (let x = r[0] + 1; x < r[2] - 1; x++) for (let z = r[1] + 1; z < r[3] - 1; z++) {
      const t = ((F.face === 0 || F.face === 2) ? x - r[0] : z - r[1]) % 5;
      for (let k = 0; k <= Math.min(t, 3); k++) setv(c, x, top + k, z, t === 4 || k === Math.min(t, 3) && t === 3 ? B.GLASS : B.ROOF);
    }
  });
  // hollow ground floor with machines
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    fillBox(c, r[0] + 1, CL, r[1] + 1, r[2] - 1, CL + 7, r[3] - 1, B.AIR);
    for (let x = r[0] + 3; x < r[2] - 2; x += 6) for (let z = r[1] + 3; z < r[3] - 3; z += 6) {
      fillBox(c, x, CL, z, x + 2, CL + 3, z + 2, B.METAL);
      setv(c, x, CL + 3, z, B.HAZARD);
      setv(c, x + 1, CL + 6, z + 1, B.LAMP);
    }
  });
  const du = Math.floor(sw / 2) - 2;
  bp.fillR(F.rect(du, 2, du + 5, 3), CL, CL + 5, B.AIR);
  bp.fillR(F.rect(du - 1, 2, du + 6, 3), CL + 5, CL + 6, B.HAZARD);
  // smokestacks
  for (let k = 0; k < 2; k++) {
    const sx = F.x(sw + 4 + k * 6, D - 5) + 0.5, sz = F.z(sw + 4 + k * 6, D - 5) + 0.5;
    const ht = 66 + Math.floor(rng() * 10);
    cylinder(bp, sx, sz, 2.2, RY, ht, B.BRICK, true, B.AIR);
    cylinder(bp, sx, sz, 2.2, ht - 6, ht - 4, B.WOOL_WHITE, true, B.AIR);
    cylinder(bp, sx, sz, 2.2, ht - 10, ht - 8, B.WOOL_RED, true, B.AIR);
    bp.paint(Math.floor(sx) - 2, Math.floor(sz) - 2, Math.floor(sx) + 2, Math.floor(sz) + 2, 0x7a3a2a, ht - CL, 'roof');
  }
  // storage tanks
  for (let k = 0; k < 2; k++) {
    const tx = F.x(sw + 4 + k * 7, 5) + 0.5, tz = F.z(sw + 4 + k * 7, 5) + 0.5;
    cylinder(bp, tx, tz, 3.2, CL, CL + 9, B.METAL);
    cylinder(bp, tx, tz, 3.2, CL + 6, CL + 7, B.HAZARD);
    cylinder(bp, tx, tz, 2.2, CL + 9, CL + 10, B.METAL);
    bp.paint(Math.floor(tx) - 3, Math.floor(tz) - 3, Math.floor(tx) + 3, Math.floor(tz) + 3, 0xa8b0b4, 10, 'roof');
  }
  // pipes from tanks to the shed
  const p0 = F.rect(sw - 1, 5, Math.min(W - 1, sw + 12), 6);
  bp.fillR(p0, CL + 7, CL + 8, B.METAL);
  roofDetails(bp, r, top, ['vent', 'vent'], null);
  bp.keepClear(F.rect(du - 1, -3, du + 6, 0));
  bp.spot(F.px(W - 4, 1.5), F.pz(W - 4, 1.5), F.yawIn + Math.PI / 2, 'truck');
  bp.roofY = top;
}

export function buildPortYard(bp) {
  const L = bp.lot, rng = bp.rng;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x9a9a94);
  // container rows along X with lanes
  for (let row = 0; row * 7 + 6 < (L.z1 - L.z0) - 4; row++) {
    const z0 = L.z0 + 5 + row * 7;
    for (let k = 0; k * 9 + 8 < (L.x1 - L.x0) - 8; k++) {
      const x0 = L.x0 + 8 + k * 9;
      if (h3(x0, row, z0, L.seed) < 0.12) continue;
      const lv = 1 + Math.floor(h3(x0, row + 3, z0, L.seed) * 3.6);
      const col = containerStack(bp, x0, z0, true, 8, lv, L.seed + row * 31 + k);
      bp.paint(x0, z0, x0 + 8, z0 + 3, WOOL_MAP.get(col) || 0x888888, lv * 3, 'roof');
    }
  }
  // yellow lane markings
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0 + 4; z < L.z1; z += 7) for (let x = L.x0 + 2; x < L.x1 - 2; x++) if (x % 3 !== 0) setv(c, x, RY, z, B.ROAD_LINE_YELLOW);
  });
  // gantry crane across the first rows
  const gx0 = L.x0 + 20, gx1 = gx0 + 3;
  for (const gz of [L.z0 + 3, L.z1 - 4]) {
    bp.fill(gx0, CL, gz, gx0 + 1, CL + 16, gz + 1, B.METAL);
    bp.fill(gx1, CL, gz, gx1 + 1, CL + 16, gz + 1, B.METAL);
  }
  bp.fill(gx0, CL + 16, L.z0 + 3, gx1 + 1, CL + 18, L.z1 - 3, B.HAZARD);
  bp.paint(gx0, L.z0 + 3, gx1 + 1, L.z1 - 3, 0xd9b026, 18, 'roof');
  // site office + light masts
  const ox = L.x0 + 1, oz = L.z0 + 1;
  bp.facade({ x0: ox, z0: oz, x1: ox + 6, z1: oz + 5, y0: CL, y1: CL + 4 }, { wall: B.WOOL_WHITE, corner: B.WOOL_BLUE, band: 0, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.8, fh: 4, rows: 0b0110, per: 2, mask: 0b01, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.WOOL_BLUE, salt: L.seed });
  bp.fill(ox + 5, CL, oz + 2, ox + 6, CL + 2, oz + 3, B.AIR);
  bp.paint(ox, oz, ox + 6, oz + 5, 0xe9ecec, 4, 'roof');
  for (const [mx, mz] of [[L.x1 - 2, L.z0 + 1], [L.x1 - 2, L.z1 - 2], [L.x0 + 1, L.z1 - 2]]) {
    bp.fill(mx, CL, mz, mx + 1, CL + 10, mz + 1, B.METAL);
    bp.set(mx, CL + 10, mz, B.LAMP);
  }
  for (let k = 0; k < 4; k++) bp.spot(L.x1 - 4.5, L.z0 + 10.5 + k * 7, 0, 'truck');
  void rng;
}

export function buildContainerYard(bp) {
  const L = bp.lot;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x9a9a94);
  for (let col = 0; col * 5 + 3 <= (L.x1 - L.x0) - 3; col++) {
    const x0 = L.x0 + 2 + col * 5;
    for (let k = 0; k * 9 + 8 <= (L.z1 - L.z0) - 2; k++) {
      const z0 = L.z0 + 1 + k * 9;
      const lv = 1 + Math.floor(h3(x0, k, z0, L.seed) * 3.4);
      const c = containerStack(bp, x0, z0, false, 8, lv, L.seed + col * 13 + k);
      bp.paint(x0, z0, x0 + 3, z0 + 8, WOOL_MAP.get(c) || 0x888888, lv * 3, 'roof');
    }
  }
}

export function buildHelipadLot(bp) {
  const L = bp.lot;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x9a9a94);
  const r = [L.x0 + 3, L.z0 + 3, L.x1 - 3, L.z1 - 3];
  helipad(bp, r, RY);
  bp.paint(r[0], r[1], r[2], r[3], 0x55565b);
  // windsock + small hangar
  bp.fill(L.x0 + 1, CL, L.z0 + 1, L.x0 + 2, CL + 6, L.z0 + 2, B.METAL);
  bp.fill(L.x0 + 2, CL + 5, L.z0 + 1, L.x0 + 4, CL + 6, L.z0 + 2, B.WOOL_ORANGE);
  bp.set(L.x0 + 4, CL + 5, L.z0 + 1, B.WOOL_WHITE);
  for (const [lx, lz] of [[L.x0 + 1, L.z1 - 2], [L.x1 - 2, L.z0 + 1], [L.x1 - 2, L.z1 - 2]]) bp.feature(feat(F_PARKLAMP, lx, lz, CL, 0, 0, 0));
}

export function buildQuay(bp) {
  const L = bp.lot, rng = bp.rng;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x9a9a94);
  const qx = L.x1 - 1;
  // quay edge: hazard strip + bollards
  bp.fill(qx, RY, L.z0, qx + 1, RY + 1, L.z1, B.HAZARD);
  for (let z = L.z0 + 2; z < L.z1; z += 6) bp.set(qx, CL, z, B.METAL);
  // two gantry cranes with booms over the water
  for (const cz of [L.z0 + 12, L.z0 + 44]) {
    for (const lx of [L.x0 + 4, L.x0 + 18]) for (const lz of [cz - 3, cz + 3]) bp.fill(lx, CL, lz, lx + 1, CL + 22, lz + 1, B.METAL);
    bp.fill(L.x0 + 3, CL + 22, cz - 3, L.x0 + 20, CL + 23, cz + 4, B.METAL);
    bp.fill(L.x0 + 4, CL + 22, cz - 2, L.x0 + 18, CL + 23, cz + 3, B.AIR);
    bp.fill(L.x0 - 2, CL + 23, cz - 1, qx + 26, CL + 25, cz + 2, B.HAZARD);
    bp.fill(L.x0 - 2, CL + 20, cz - 2, L.x0 + 2, CL + 23, cz + 3, B.CONCRETE_DARK);
    bp.fill(L.x0 + 14, CL + 19, cz - 1, L.x0 + 17, CL + 22, cz + 2, B.WOOL_YELLOW);
    bp.fill(L.x0 + 14, CL + 20, cz - 1, L.x0 + 15, CL + 21, cz + 2, B.WINDOW_LIT);
    bp.fill(qx + 14, CL + 13, cz, qx + 15, CL + 23, cz + 1, B.METAL);
    bp.fill(qx + 13, CL + 12, cz - 1, qx + 16, CL + 13, cz + 2, B.METAL);
    bp.paint(L.x0 - 2, cz - 1, qx + 26, cz + 2, 0xd9b026, 25, 'roof');
  }
  // cargo ship moored at the quay
  const sx0 = qx + 5, sx1 = sx0 + 13, sz0 = L.z0 + 4, sz1 = L.z1 - 4;
  const scx = (sx0 + sx1) / 2;
  bp.op(sx0, sz0, sx1, sz1, (c) => {
    for (let z = sz0; z < sz1; z++) {
      const bow = z - sz0 < 9 ? (z - sz0 + 1) / 9 : 1;
      const stern = sz1 - z < 3 ? 0.85 : 1;
      const hw = 6.5 * Math.sqrt(bow) * stern;
      for (let x = sx0; x < sx1; x++) {
        const d = Math.abs(x + 0.5 - scx);
        if (d > hw) continue;
        const side = d > hw - 1;
        for (let y = 17; y <= RY; y++) {
          let id;
          if (side) id = y < 20 ? B.WOOL_RED : y === RY - 1 ? B.WOOL_WHITE : B.CONCRETE_DARK;
          else id = y === RY ? B.METAL : B.CONCRETE_DARK;
          setv(c, x, y, z, id);
        }
        if (side) setv(c, x, CL, z, B.METAL);
      }
    }
  });
  bp.paint(sx0, sz0, sx1, sz1, 0x5a5c62, 0, 'roof');
  // containers on deck
  for (let k = 0; k < 4; k++) {
    const z0 = sz0 + 11 + k * 8;
    if (z0 + 7 > sz1 - 12) break;
    for (const xo of [sx0 + 3, sx0 + 7]) {
      const lv = 1 + Math.floor(h3(xo, k, z0, L.seed) * 2.5);
      const col = containerStack(bp, xo, z0, false, 7, lv, L.seed + k * 7 + xo);
      bp.paint(xo, z0, xo + 3, z0 + 7, WOOL_MAP.get(col) || 0x888888, lv * 3, 'roof');
    }
  }
  // bridge house at the stern + funnel
  const bz0 = sz1 - 10, bz1 = sz1 - 3;
  bp.facade({ x0: sx0 + 2, z0: bz0, x1: sx1 - 2, z1: bz1, y0: CL, y1: CL + 12 }, { wall: B.WOOL_WHITE, corner: B.WOOL_WHITE, band: 0, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.5, fh: 3, rows: 0b010, per: 2, mask: 0b01, off: 0, fill: B.CONCRETE, roof: B.METAL, parapet: B.METAL, salt: L.seed });
  bp.paint(sx0 + 2, bz0, sx1 - 2, bz1, 0xe9ecec, 12, 'roof');
  cylinder(bp, scx, bz0 + 4.5, 1.6, CL + 12, CL + 18, B.WOOL_RED);
  cylinder(bp, scx, bz0 + 4.5, 1.6, CL + 18, CL + 19, B.WOOL_BLACK);
  bp.fill(Math.floor(scx), CL + 12, bz1 - 2, Math.floor(scx) + 1, CL + 20, bz1 - 1, B.METAL);
  bp.set(Math.floor(scx), CL + 20, bz1 - 2, B.NEON_PINK);
  // gangway from the quay to the deck
  const gz = L.z0 + 30;
  bp.fill(qx + 1, RY, gz, sx0 + 2, RY + 1, gz + 2, B.PLANKS);
  bp.fill(qx + 1, CL, gz - 1, sx0 + 1, CL + 1, gz, B.METAL);
  bp.fill(qx + 1, CL, gz + 2, sx0 + 1, CL + 1, gz + 3, B.METAL);
  bp.fill(sx0, CL, gz, sx0 + 2, CL + 1, gz + 2, B.AIR);
  bp.paint(qx + 1, gz, sx0 + 2, gz + 2, 0xa8854e);
  // crates + parked trucks on the quay
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0 + 18; z < L.z0 + 38; z++) for (let x = L.x0 + 7; x < L.x0 + 13; x++) {
      const hh = h3(x, 3, z, 17);
      if (hh < 0.35) { setv(c, x, CL, z, B.CRATE); if (hh < 0.12) setv(c, x, CL + 1, z, B.CRATE); }
    }
  });
  bp.spot(L.x0 + 3.5, L.z1 - 6.5, Math.PI, 'truck');
  bp.spot(L.x0 + 7.5, L.z1 - 6.5, Math.PI, 'truck');
  void rng;
}

// ------------------------------------------------------------------------------------------------
// Farm
// ------------------------------------------------------------------------------------------------
export function buildFarmhouse(bp) {
  buildHouse(bp, { pal: { wall: B.PLANKS, trim: B.LOG, roof: B.TERRACOTTA, color: 0xa0583a }, storeys: 2, pool: false, path: B.GRAVEL, lamp: true });
}

export function buildBarn(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.GRAVEL);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x8a8070);
  const r = F.rect(1, 2, W - 1, D);
  const wallTop = CL + 7;
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: wallTop };
  bp.facade(box, { wall: B.WOOL_RED, corner: B.WOOL_WHITE, band: B.WOOL_WHITE, win: B.WOOL_WHITE, lit: B.WOOL_WHITE, litP: 0, fh: 7, rows: 0b0001000, per: 4, mask: 0b0100, off: 0, fill: B.AIR, roof: B.PLANKS, parapet: 0, salt: L.seed });
  // gambrel roof: ridge along the depth axis
  const half = (W - 2) / 2;
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    for (let v = 2; v < D; v++) for (let u = 1; u < W - 1; u++) {
      const du = Math.abs(u + 0.5 - W / 2);
      const k = Math.floor(half - du);
      const yR = wallTop - 1 + (k < 2 ? k * 2 : 4 + (k - 2));
      const x = F.x(u, v), z = F.z(u, v);
      setv(c, x, yR, z, B.PLANKS);
      if (v === 2 || v === D - 1) for (let y = wallTop - 1; y < yR; y++) setv(c, x, y, z, B.WOOL_RED);
    }
  });
  bp.paint(r[0], r[1], r[2], r[3], 0x9a5a34, 12, 'roof');
  // hollow inside with hay and a loft
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    fillBox(c, r[0] + 1, CL, r[1] + 1, r[2] - 1, wallTop - 1, r[3] - 1, B.AIR);
    for (let x = r[0] + 1; x < r[2] - 1; x++) for (let z = r[1] + 1; z < r[3] - 1; z++) {
      const hh = h3(x, 9, z, 7);
      if (hh < 0.18) { setv(c, x, CL, z, B.WOOL_YELLOW); if (hh < 0.07) setv(c, x, CL + 1, z, B.WOOL_YELLOW); }
    }
    fillBox(c, r[0] + 1, CL + 4, r[1] + 1, r[0] + 4, CL + 5, r[3] - 1, B.PLANKS);
    setv(c, (r[0] + r[2]) >> 1, wallTop - 2, (r[1] + r[3]) >> 1, B.LAMP);
  });
  // big door (open) with white X frames
  const du = (W >> 1) - 2;
  bp.fillR(F.rect(du, 2, du + 4, 3), CL, CL + 5, B.AIR);
  bp.fillR(F.rect(du - 1, 2, du, 3), CL, CL + 6, B.WOOL_WHITE);
  bp.fillR(F.rect(du + 4, 2, du + 5, 3), CL, CL + 6, B.WOOL_WHITE);
  bp.fillR(F.rect(du - 1, 2, du + 5, 3), CL + 5, CL + 6, B.WOOL_WHITE);
  // hay bales outside
  for (let k = 0; k < 3; k++) bp.feature(feat(F_HAYBALE, F.x(1 + k * 2, 1), F.z(1 + k * 2, 1), CL, k % 2, k === 1 ? 1 : 0, 1));
}

export function buildField(bp) {
  const L = bp.lot;
  const alongX = (L.x1 - L.x0) >= (L.z1 - L.z0);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x8a7a3a);
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let z = L.z0; z < L.z1; z++) for (let x = L.x0; x < L.x1; x++) {
      const edge = x === L.x0 || z === L.z0 || x === L.x1 - 1 || z === L.z1 - 1;
      const row = alongX ? z - L.z0 : x - L.x0;
      if (edge) { setv(c, x, RY, z, B.GRASS); if ((x + z) % 9 !== 0) setv(c, x, CL, z, B.HEDGE); continue; }
      if (row % 5 === 2) { setv(c, x, RY, z, B.WATER); setv(c, x, RY - 1, z, B.DIRT); continue; }
      setv(c, x, RY, z, B.DIRT);
      const hh = h3(x, 5, z, 3);
      const crop = (Math.floor((alongX ? x : z) / 9) + row) % 3;
      setv(c, x, CL, z, crop === 0 ? B.FLOWER_YELLOW : crop === 1 ? B.TALL_GRASS : (hh < 0.6 ? B.TALL_GRASS : B.FLOWER_YELLOW));
    }
  });
  for (let z = L.z0 + 1; z < L.z1 - 1; z++) for (let x = L.x0 + 1; x < L.x1 - 1; x++) if ((alongX ? z - L.z0 : x - L.x0) % 5 === 2) bp.wet(x, z, x + 1, z + 1);
  bp.mapFn = (put) => {
    for (let z = L.z0 + 1; z < L.z1 - 1; z++) for (let x = L.x0 + 1; x < L.x1 - 1; x++) {
      const row = alongX ? z - L.z0 : x - L.x0;
      const crop = (Math.floor((alongX ? x : z) / 9) + row) % 3;
      put(x, z, row % 5 === 2 ? 0x3d86d6 : crop === 0 ? 0xc8b040 : crop === 1 ? 0x7aa040 : 0xa8a040);
    }
  };
  // scarecrow
  const sx = (L.x0 + L.x1) >> 1, sz = (L.z0 + L.z1) >> 1;
  bp.fill(sx, CL, sz, sx + 1, CL + 3, sz + 1, B.LOG);
  bp.fill(sx - 1, CL + 2, sz, sx + 2, CL + 3, sz + 1, B.PLANKS);
  bp.set(sx, CL + 3, sz, B.WOOL_ORANGE);
  bp.set(sx, CL + 4, sz, B.WOOL_YELLOW);
}

export function buildFarmyard(bp) {
  const L = bp.lot;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.GRAVEL);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x8a8070);
  // silo
  const cx = L.x0 + 4.5, cz = L.z0 + 4.5;
  cylinder(bp, cx, cz, 3.2, CL, CL + 16, B.METAL, true, B.AIR);
  for (let y = CL + 3; y < CL + 16; y += 4) cylinder(bp, cx, cz, 3.2, y, y + 1, B.CONCRETE, true, B.AIR);
  cylinder(bp, cx, cz, 2.6, CL + 16, CL + 17, B.METAL);
  cylinder(bp, cx, cz, 1.6, CL + 17, CL + 18, B.METAL);
  bp.paint(L.x0 + 1, L.z0 + 1, L.x0 + 8, L.z0 + 8, 0xb0b8bc, 18, 'roof');
  // tractor
  const tx = L.x0 + 9, tz = L.z0 + 8;
  bp.fill(tx, CL, tz, tx + 3, CL + 1, tz + 5, B.WOOL_GREEN);
  bp.fill(tx, CL + 1, tz + 3, tx + 3, CL + 3, tz + 5, B.WOOL_GREEN);
  bp.fill(tx, CL + 1, tz + 3, tx + 3, CL + 2, tz + 4, B.GLASS);
  for (const [wx, wz] of [[tx - 1, tz], [tx + 3, tz], [tx - 1, tz + 3], [tx + 3, tz + 3]]) bp.fill(wx, CL, wz, wx + 1, CL + 2, wz + 2, B.WOOL_BLACK);
  bp.paint(tx - 1, tz, tx + 4, tz + 5, 0x5e7c16, 3, 'roof');
  // hay bales, crates, fence
  for (let k = 0; k < 5; k++) bp.feature(feat(F_HAYBALE, L.x1 - 3, L.z0 + 2 + k * 2, CL, 1, k % 2, 1));
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let x = L.x0; x < L.x1; x++) { setv(c, x, CL, L.z1 - 1, x % 3 === 0 ? B.LOG : B.PLANKS); }
    for (let z = L.z0; z < L.z1; z++) { setv(c, L.x1 - 1, CL, z, z % 3 === 0 ? B.LOG : B.PLANKS); }
  });
  bp.spot(L.x0 + 4.5, L.z1 - 2.5, Math.PI / 2, 'farm');
}

