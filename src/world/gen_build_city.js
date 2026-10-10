// City building blueprints: downtown towers, mid-rises, old-town walk-ups, bayfront hotels, houses and the POI buildings.
import { B } from './blocks.js';
import { CL, RY, h3, WOOLS } from './gen_const.js';
import { Frame, hollow, roofDetails, helipad, storefront, roadSides, shade, fillBox, setv, stairZone, stairMapper } from './gen_build_core.js';
import { feat, F_OAK, F_PARKLAMP } from './gen_features.js';

const Q4 = (h) => Math.max(1, Math.round(h / 4)) * 4;
const top95 = (y) => Math.min(y, 94);

// ------------------------------------------------------------------------------------------------
// Style palettes
// ------------------------------------------------------------------------------------------------
const TOWER_STYLES = [
  { name: 'glass', wall: B.METAL, corner: B.METAL, band: B.CONCRETE_DARK, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.33, rows: 0b1110, per: 4, mask: 0b1110, fill: B.CONCRETE, roof: B.ROOF, parapet: B.METAL, color: 0x7f9db6 },
  { name: 'concrete', wall: B.CONCRETE, corner: B.CONCRETE, band: 0, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.36, rows: 0b0110, per: 3, mask: 0b011, fill: B.CONCRETE, roof: B.ROOF, parapet: B.CONCRETE, color: 0xb4b4ae },
  { name: 'deco', wall: B.SANDSTONE, corner: B.MARBLE, band: 0, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.4, rows: 0b0110, per: 2, mask: 0b01, fill: B.SANDSTONE, roof: B.ROOF, parapet: B.MARBLE, color: 0xcdbd86 },
  { name: 'dark', wall: B.CONCRETE_DARK, corner: B.CONCRETE_DARK, band: B.CONCRETE_DARK, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.3, rows: 0b0110, per: 1, mask: 1, fill: B.CONCRETE_DARK, roof: B.ROOF, parapet: B.METAL, color: 0x5e6066 },
  { name: 'white', wall: B.TILE_WHITE, corner: B.MARBLE, band: 0, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.36, rows: 0b0110, per: 3, mask: 0b110, fill: B.CONCRETE, roof: B.ROOF, parapet: B.TILE_WHITE, color: 0xdedcd4 },
  { name: 'ribbon', wall: B.METAL, corner: B.CONCRETE_DARK, band: B.METAL, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.3, rows: 0b1111, per: 6, mask: 0b111110, fill: B.CONCRETE, roof: B.ROOF, parapet: B.CONCRETE_DARK, color: 0x6f8aa3 },
];

const MID_PALETTES = [
  { wall: B.BRICK, trim: B.CONCRETE, color: 0x9b4a3a },
  { wall: B.PLASTER, trim: B.SANDSTONE, color: 0xd9c9a8 },
  { wall: B.SANDSTONE, trim: B.MARBLE, color: 0xd8c98f },
  { wall: B.CONCRETE, trim: B.CONCRETE_DARK, color: 0xb9b9b4 },
  { wall: B.STUCCO_TEAL, trim: B.PLASTER, color: 0x5fb3a8 },
  { wall: B.BRICK, trim: B.COBBLESTONE, color: 0x93473a },
  { wall: B.TERRACOTTA, trim: B.SANDSTONE, color: 0xa0583a },
];
const HOTEL_PALETTES = [
  { wall: B.STUCCO_PINK, trim: B.TILE_WHITE, color: 0xe3a0a8 },
  { wall: B.STUCCO_TEAL, trim: B.TILE_WHITE, color: 0x5fb3a8 },
  { wall: B.TILE_WHITE, trim: B.STUCCO_PINK, color: 0xe6e6e1 },
  { wall: B.PLASTER, trim: B.STUCCO_TEAL, color: 0xd9c9a8 },
  { wall: B.TILE_WHITE, trim: B.STUCCO_TEAL, color: 0xe6e6e1 },
];
const WALKUP_PALETTES = [
  { wall: B.BRICK, trim: B.COBBLESTONE, color: 0x9b4a3a },
  { wall: B.BRICK, trim: B.CONCRETE, color: 0x9b4a3a },
  { wall: B.TERRACOTTA, trim: B.SANDSTONE, color: 0xa0583a },
  { wall: B.PLASTER, trim: B.BRICK, color: 0xd9c9a8 },
  { wall: B.COBBLESTONE, trim: B.PLANKS, color: 0x727272 },
  { wall: B.BRICK, trim: B.SANDSTONE, color: 0x8f4536 },
];
const AWNINGS = [
  [B.WOOL_RED, B.WOOL_WHITE], [B.WOOL_GREEN, B.WOOL_WHITE], [B.WOOL_BLUE, B.WOOL_WHITE], [B.WOOL_YELLOW, B.WOOL_ORANGE],
  [B.WOOL_PURPLE, B.WOOL_WHITE], [B.WOOL_ORANGE, B.WOOL_WHITE], [B.WOOL_BLACK, B.WOOL_YELLOW],
];
const SIGNS = [B.NEON_PINK, B.NEON_BLUE];

const pick = (rng, a) => a[Math.floor(rng() * a.length)];

/** Cornice ring one block outside the footprint on road-facing sides at height y. */
function cornice(bp, fp, y, id, sides) {
  const [x0, z0, x1, z1] = fp;
  if (sides & 1) bp.fill(x0 - ((sides & 8) ? 1 : 0), y, z0 - 1, x1 + ((sides & 2) ? 1 : 0), y + 1, z0, id);
  if (sides & 4) bp.fill(x0 - ((sides & 8) ? 1 : 0), y, z1, x1 + ((sides & 2) ? 1 : 0), y + 1, z1 + 1, id);
  if (sides & 8) bp.fill(x0 - 1, y, z0, x0, y + 1, z1, id);
  if (sides & 2) bp.fill(x1, y, z0, x1 + 1, y + 1, z1, id);
}

/** Register the rooftop landing of a hollow building's stairwell as an accessible rooftop point. */
function roofExit(bp, box, back) {
  const fh = 4, yTop = box.y1 - 1;
  const flights = Math.floor((yTop - (box.y0 - 1)) / fh);
  if (flights < 1 || (yTop - (box.y0 - 1)) % fh !== 0) return;
  const lane = (flights - 1) % 2;
  const [x, z] = stairMapper(box, back)(lane === 0 ? fh : 0, lane);
  bp.rooftop(x, box.y1, z);
}

/** Simple entrance: door gap in the front facade + small lobby behind it. */
function entrance(bp, F, doorU, doorW, fv, depth, floorId, frame = B.GLASS) {
  for (let u = doorU; u < doorU + doorW; u++) {
    const x = F.x(u, fv), z = F.z(u, fv);
    bp.fill(x, CL, z, x + 1, CL + 2, z + 1, B.AIR);
    bp.set(x, CL + 2, z, frame);
  }
  const r = F.rect(Math.max(1, doorU - 2), fv + 1, Math.min(F.W - 1, doorU + doorW + 2), fv + 1 + depth);
  bp.fillR(r, CL, CL + 3, B.AIR);
  bp.fillR(r, RY, RY + 1, floorId);
  const lr = F.rect(doorU, fv + 2, doorU + 1, fv + 3);
  bp.fillR(lr, CL + 3, CL + 4, B.LAMP);
}

// ------------------------------------------------------------------------------------------------
// Downtown tower
// ------------------------------------------------------------------------------------------------
export function buildTower(bp) {
  const L = bp.lot, rng = bp.rng;
  const st0 = TOWER_STYLES[Math.floor(rng() * TOWER_STYLES.length)];
  const st = { ...st0, salt: L.seed, fh: 4 };
  const F = new Frame(L);
  const paving = rng() < 0.5 ? B.TILE_WHITE : B.MARBLE;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, paving);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0xcfcac0);
  // footprint: square or slab
  let fp = [L.x0 + 1, L.z0 + 1, L.x1 - 1, L.z1 - 1];
  if (rng() < 0.35) {
    if (F.face === 0 || F.face === 2) fp = [fp[0], fp[1] + 2, fp[2], fp[3] - 2];
    else fp = [fp[0] + 2, fp[1], fp[2] - 2, fp[3]];
  }
  const H = L.height;
  const top = Math.min(CL + Q4(H), 90);
  const setbacks = rng() < 0.8;
  const ya = setbacks ? CL + Q4(H * 0.5) : top;
  const yb = setbacks ? CL + Q4(H * 0.78) : top;
  const tiers = [];
  tiers.push({ x0: fp[0], z0: fp[1], x1: fp[2], z1: fp[3], y0: CL, y1: ya });
  if (setbacks) {
    const i1 = 2, i2 = rng() < 0.5 ? 4 : 3;
    if (yb > ya) tiers.push({ x0: fp[0] + i1, z0: fp[1] + i1, x1: fp[2] - i1, z1: fp[3] - i1, y0: ya, y1: yb });
    if (top > yb) tiers.push({ x0: fp[0] + i2, z0: fp[1] + i2, x1: fp[2] - i2, z1: fp[3] - i2, y0: yb, y1: top });
  }
  for (const t of tiers) {
    bp.facade(t, st);
    bp.paint(t.x0, t.z0, t.x1, t.z1, st.color, t.y1 - CL, 'roof');
  }
  // crown band (lit) at the very top of the last tier for some styles
  const last = tiers[tiers.length - 1];
  if (rng() < 0.45) {
    const neon = pick(rng, [B.NEON_BLUE, B.NEON_PINK, B.LAMP]);
    bp.op(last.x0, last.z0, last.x1, last.z1, (c) => {
      for (let x = last.x0; x < last.x1; x++) { setv(c, x, last.y1 - 2, last.z0, neon); setv(c, x, last.y1 - 2, last.z1 - 1, neon); }
      for (let z = last.z0; z < last.z1; z++) { setv(c, last.x0, last.y1 - 2, z, neon); setv(c, last.x1 - 1, last.y1 - 2, z, neon); }
    });
  }
  // lobby: glass ground floor, hollow with marble floor, elevator core
  const t0 = tiers[0];
  bp.op(t0.x0, t0.z0, t0.x1, t0.z1, (c) => hollow(c, t0, { fh: 4, slab: st.fill, floor: B.MARBLE, fromY: CL, toY: CL + 4 }));
  bp.op(t0.x0, t0.z0, t0.x1, t0.z1, (c) => {
    for (let x = t0.x0; x < t0.x1; x++) for (const z of [t0.z0, t0.z1 - 1]) {
      if (x === t0.x0 || x === t0.x1 - 1) continue;
      const pillar = (x - t0.x0) % 4 === 0;
      for (let y = CL; y < CL + 3; y++) setv(c, x, y, z, pillar ? st.corner : B.GLASS);
    }
    for (let z = t0.z0 + 1; z < t0.z1 - 1; z++) for (const x of [t0.x0, t0.x1 - 1]) {
      const pillar = (z - t0.z0) % 4 === 0;
      for (let y = CL; y < CL + 3; y++) setv(c, x, y, z, pillar ? st.corner : B.GLASS);
    }
    const cx = (t0.x0 + t0.x1) >> 1, cz = (t0.z0 + t0.z1) >> 1;
    fillBox(c, cx - 2, CL, cz - 2, cx + 2, CL + 3, cz + 2, B.CONCRETE_DARK);
    fillBox(c, cx - 1, CL, cz - 2, cx + 1, CL + 2, cz - 1, B.METAL);
    fillBox(c, cx - 1, CL, cz + 1, cx + 1, CL + 2, cz + 2, B.METAL);
  });
  // front doors (2 wide, centred) on the lobby glass + a canopy
  const Fp = new Frame({ x0: t0.x0, z0: t0.z0, x1: t0.x1, z1: t0.z1 }, F.face);
  const du = (Fp.W >> 1) - 1;
  for (let u = du; u < du + 2; u++) bp.fill(Fp.x(u, 0), CL, Fp.z(u, 0), Fp.x(u, 0) + 1, CL + 2, Fp.z(u, 0) + 1, B.AIR);
  {
    // standing point on the sidewalk middle (1.5 outside the lot edge) in front of the lobby doors
    const ex = Fp.px(du + 1, 0), ez = Fp.pz(du + 1, 0);
    const sx = F.dx > 0 ? L.x1 + 1.5 : F.dx < 0 ? L.x0 - 1.5 : ex;
    const sz = F.dz > 0 ? L.z1 + 1.5 : F.dz < 0 ? L.z0 - 1.5 : ez;
    L.entrance = { x: sx, y: CL, z: sz, yaw: F.yawIn };
  }
  const can = Fp.rect(du - 2, -1, du + 4, 0);
  bp.fillR(can, CL + 3, CL + 4, st.corner === B.METAL ? B.CONCRETE_DARK : st.corner);
  bp.fillR(Fp.rect(du - 1, 0, du + 3, 1), RY, RY + 1, B.CARPET_RED);
  // terraces on setbacks: planters + AC
  for (let k = 1; k < tiers.length; k++) {
    const lower = tiers[k - 1];
    roofDetails(bp, [lower.x0, lower.z0, lower.x1, lower.z1], lower.y1, ['ac', 'vent'], [tiers[k].x0 - 1, tiers[k].z0 - 1, tiers[k].x1 + 1, tiers[k].z1 + 1]);
  }
  // crown
  const cw = last.x1 - last.x0, cd = last.z1 - last.z0;
  const roof = last.y1;
  const kind = pick(rng, ['spire', 'antenna', 'helipad', 'pyramid', 'spire', 'helipad', 'mech']);
  const cx = Math.floor((last.x0 + last.x1) / 2), cz = Math.floor((last.z0 + last.z1) / 2);
  if (kind === 'helipad' && cw >= 9 && cd >= 9) {
    helipad(bp, [last.x0 + 1, last.z0 + 1, last.x1 - 1, last.z1 - 1], roof - 1);
  } else if (kind === 'pyramid') {
    for (let k = 0; ; k++) {
      const r = [last.x0 + k, last.z0 + k, last.x1 - k, last.z1 - k];
      if (r[2] - r[0] < 1 || r[3] - r[1] < 1 || roof + k > 94) break;
      bp.fill(r[0], roof + k, r[1], r[2], roof + k + 1, r[3], k % 2 === 0 ? st.win : st.corner);
      bp.paint(r[0], r[1], r[2], r[3], shade(st.color, 1.06), roof + k - CL, 'roof');
    }
  } else if (kind === 'mech') {
    const r = [last.x0 + 2, last.z0 + 2, last.x1 - 2, last.z1 - 2];
    if (r[2] - r[0] >= 3 && r[3] - r[1] >= 3) {
      bp.fill(r[0], roof, r[1], r[2], Math.min(95, roof + 3), r[3], B.CONCRETE_DARK);
      bp.fill(r[0], Math.min(95, roof + 3), r[1], r[2], Math.min(96, roof + 4), r[3], B.METAL);
      roofDetails(bp, [last.x0, last.z0, last.x1, last.z1], roof, ['antenna', 'antenna'], r);
    }
  } else {
    // spire / antenna
    const hh = kind === 'spire' ? 12 : 8;
    if (kind === 'spire') bp.fill(cx - 1, roof, cz - 1, cx + 1, top95(roof + 4), cz + 1, B.METAL);
    bp.fill(cx, roof, cz, cx + 1, top95(roof + hh), cz + 1, B.METAL);
    bp.set(cx, top95(roof + hh), cz, kind === 'spire' ? B.LAMP : B.NEON_PINK);
  }
  bp.roofY = roof;
}

// ------------------------------------------------------------------------------------------------
// Mid-rise (midtown / market) and bayfront hotels
// ------------------------------------------------------------------------------------------------
export function buildMidrise(bp, hotel = false) {
  const L = bp.lot, rng = bp.rng, P = bp.P;
  const pal = pick(rng, hotel ? HOTEL_PALETTES : MID_PALETTES);
  const F = new Frame(L);
  const sides = roadSides(P, L);
  const fp = [L.x0, L.z0, L.x1, L.z1];
  const H = Math.max(9, L.height);
  const top = Math.min(CL + Q4(H), 90);
  const hollowB = !!L.hollow && !hotel;
  const winPat = pick(rng, [[3, 0b011], [3, 0b110], [2, 0b01], [4, 0b0110]]);
  const st = {
    wall: pal.wall, corner: pal.trim, band: rng() < 0.4 ? pal.trim : 0,
    win: hollowB ? B.GLASS : B.WINDOW, lit: hollowB ? B.GLASS : B.WINDOW_LIT, litP: hollowB ? 0 : (hotel ? 0.45 : 0.36),
    fh: 4, rows: 0b0110, per: winPat[0], mask: winPat[1], off: 1, fill: B.CONCRETE, roof: B.ROOF, parapet: pal.trim, salt: L.seed,
  };
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  // optional setback crown for tall buildings
  const W = fp[2] - fp[0], D = fp[3] - fp[1];
  const setback = top - CL >= 20 && W >= 10 && D >= 10 && rng() < 0.6;
  const ys = setback ? CL + Q4((top - CL) * 0.68) : top;
  const box = { x0: fp[0], z0: fp[1], x1: fp[2], z1: fp[3], y0: CL, y1: ys };
  bp.facade(box, st);
  bp.paint(fp[0], fp[1], fp[2], fp[3], pal.color, ys - CL, 'roof');
  let roofBox = box;
  if (setback) {
    const inset = W >= 14 ? 2 : 1;
    const b2 = { x0: fp[0] + inset, z0: fp[1] + inset, x1: fp[2] - inset, z1: fp[3] - inset, y0: ys, y1: top };
    bp.facade(b2, st);
    bp.paint(b2.x0, b2.z0, b2.x1, b2.z1, shade(pal.color, 1.08), top - CL, 'roof');
    roofDetails(bp, fp, ys, ['ac', 'garden'], [b2.x0 - 1, b2.z0 - 1, b2.x1 + 1, b2.z1 + 1]);
    roofBox = b2;
  }
  let stairAvoid = null;
  const back = (L.front + 2) % 4;
  if (hollowB) {
    bp.op(box.x0, box.z0, box.x1, box.z1, (c) => hollow(c, box, { fh: 4, slab: B.CONCRETE, floor: B.PLANKS, stairs: !setback, back, furnish: true, salt: L.seed }));
    const zr = stairZone(box, back);
    stairAvoid = [zr[0] - 1, zr[1] - 1, zr[2] + 1, zr[3] + 1];
    if (!setback) roofExit(bp, box, back);
  }
  // cornice
  if (rng() < 0.75) cornice(bp, [roofBox.x0, roofBox.z0, roofBox.x1, roofBox.z1], roofBox.y1 - 1, pal.trim, setback ? 0 : sides);
  if (rng() < 0.5) cornice(bp, fp, CL + 4, pal.trim, sides);
  // ground floor
  const doorU = (F.W >> 1) - 1;
  bp.door(F, doorU, 0, 2);
  if (L.type === 'shop' || rng() < 0.45) {
    const aw = pick(rng, AWNINGS);
    storefront(bp, F, 0, F.W, 0, { wall: pal.trim, sign: pick(rng, SIGNS), awning: aw, doorU, doorW: 2, floor: pick(rng, [B.TILE_WHITE, B.PLANKS, B.MARBLE]), interiorDepth: Math.min(6, F.D - 4), shelf: hollowB ? 0 : undefined });
  } else {
    entrance(bp, F, doorU, 2, 0, 3, hotel ? B.CARPET_RED : B.MARBLE);
    if (hotel) {
      const can = F.rect(doorU - 1, -1, doorU + 3, 0);
      bp.fillR(can, CL + 3, CL + 4, pal.trim);
    }
  }
  if (hotel) {
    // balconies on road-facing sides + vertical neon sign
    const bal = pal.trim;
    const per = st.per, mask = st.mask;
    const floors = Math.floor((ys - CL) / 4);
    bp.op(fp[0] - 1, fp[1] - 1, fp[2] + 1, fp[3] + 1, (c) => {
      for (let f = 1; f < floors; f++) {
        if (f % 2 === 0) continue;
        const y = CL + f * 4;
        const doSide = (side, len, cell) => {
          if (!(sides & (1 << side))) return;
          for (let u = 1; u < len - 1; u++) {
            if (!((mask >> ((u + 1) % per)) & 1)) continue;
            const [x, z] = cell(u);
            setv(c, x, y, z, bal);
            setv(c, x, y + 1, z, B.GLASS);
          }
        };
        doSide(0, W, (u) => [fp[0] + u, fp[1] - 1]);
        doSide(2, W, (u) => [fp[0] + u, fp[3]]);
        doSide(3, D, (u) => [fp[0] - 1, fp[1] + u]);
        doSide(1, D, (u) => [fp[2], fp[1] + u]);
      }
    });
    // vertical neon blade sign at a road corner
    const neon = pick(rng, SIGNS);
    const cxs = (sides & 2) ? fp[2] : fp[0] - 1;
    const czs = (sides & 4) ? fp[3] - 2 : fp[1] + 1;
    bp.fill(cxs, CL + 5, czs, cxs + 1, Math.min(ys - 1, CL + 18), czs + 1, neon);
    // rooftop pool
    if (roofBox.x1 - roofBox.x0 >= 10 && roofBox.z1 - roofBox.z0 >= 10) {
      const r = [roofBox.x0 + 2, roofBox.z0 + 3, roofBox.x1 - 2, roofBox.z1 - 3];
      const y = roofBox.y1;
      bp.fill(r[0] - 1, y - 1, r[1] - 1, r[2] + 1, y, r[3] + 1, B.TILE_WHITE);
      bp.fill(r[0] - 1, y, r[1] - 1, r[2] + 1, y + 1, r[3] + 1, B.TILE_WHITE);
      bp.fill(r[0], y - 2, r[1], r[2], y - 1, r[3], B.TILE_WHITE);
      bp.fill(r[0], y - 1, r[1], r[2], y + 1, r[3], B.WATER);
      bp.paint(r[0], r[1], r[2], r[3], 0x4fb3e0, y - CL, 'roof');
      bp.fill(roofBox.x0 + 1, y, roofBox.z0 + 1, roofBox.x0 + 3, y + 1, roofBox.z0 + 2, B.WOOL_WHITE);
      bp.fill(roofBox.x1 - 3, y, roofBox.z1 - 2, roofBox.x1 - 1, y + 1, roofBox.z1 - 1, B.WOOL_WHITE);
    } else roofDetails(bp, [roofBox.x0, roofBox.z0, roofBox.x1, roofBox.z1], roofBox.y1, ['garden', 'ac'], stairAvoid);
  } else {
    const kinds = pick(rng, [['tower', 'ac', 'vent'], ['housing', 'ac', 'antenna'], ['solar', 'ac'], ['garden', 'vent', 'ac'], ['tower', 'antenna']]);
    roofDetails(bp, [roofBox.x0, roofBox.z0, roofBox.x1, roofBox.z1], roofBox.y1, kinds, stairAvoid);
    // billboard on some roofs facing the front street
    if (rng() < 0.18 && F.W >= 10) {
      const y = roofBox.y1;
      const r = F.rect(2, 1, F.W - 2, 2);
      bp.fillR(r, y, y + 1, B.METAL);
      const colA = pick(rng, WOOLS), colB = pick(rng, WOOLS);
      bp.op(r[0], r[1], r[2], r[3], (c) => {
        for (let z = r[1]; z < r[3]; z++) for (let x = r[0]; x < r[2]; x++) for (let y2 = y + 1; y2 < y + 5 && y2 < 96; y2++) {
          setv(c, x, y2, z, y2 === y + 1 || y2 === y + 4 ? B.WOOL_BLACK : ((x + z + y2) % 5 === 0 ? colB : colA));
        }
      });
    }
  }
  bp.roofY = top;
}

// ------------------------------------------------------------------------------------------------
// Old-town walk-ups (narrow brick buildings, fire escapes, shops at street level)
// ------------------------------------------------------------------------------------------------
export function buildWalkup(bp) {
  const L = bp.lot, rng = bp.rng, P = bp.P;
  const pal = pick(rng, WALKUP_PALETTES);
  const F = new Frame(L);
  const sides = roadSides(P, L);
  const top = Math.min(CL + Q4(Math.max(8, L.height)), 90);
  const hollowB = !!L.hollow;
  const st = {
    wall: pal.wall, corner: pal.trim, band: 0, win: hollowB ? B.GLASS : B.WINDOW, lit: hollowB ? B.GLASS : B.WINDOW_LIT, litP: hollowB ? 0 : 0.42,
    fh: 4, rows: 0b0110, per: 2, mask: 0b01, off: 1, fill: B.CONCRETE, roof: B.ROOF, parapet: pal.trim, salt: L.seed,
  };
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  const box = { x0: L.x0, z0: L.z0, x1: L.x1, z1: L.z1, y0: CL, y1: top };
  bp.facade(box, st);
  bp.paint(L.x0, L.z0, L.x1, L.z1, pal.color, top - CL, 'roof');
  let avoid = null;
  const back = (L.front + 2) % 4;
  if (hollowB) {
    bp.op(box.x0, box.z0, box.x1, box.z1, (c) => hollow(c, box, { fh: 4, slab: B.PLANKS, floor: B.PLANKS, stairs: true, back, furnish: true, salt: L.seed }));
    const zr = stairZone(box, back);
    avoid = [zr[0] - 1, zr[1] - 1, zr[2] + 1, zr[3] + 1];
    roofExit(bp, box, back);
  }
  cornice(bp, [L.x0, L.z0, L.x1, L.z1], top - 1, pal.trim, sides);
  cornice(bp, [L.x0, L.z0, L.x1, L.z1], CL + 4, pal.trim, sides);
  const doorU = Math.max(1, (F.W >> 1) - 1);
  bp.door(F, doorU, 0, L.type === 'shop' ? 2 : 1);
  if (L.type === 'shop' && L.style !== 'gunshop') {
    storefront(bp, F, 0, F.W, 0, { wall: pal.trim, sign: pick(rng, SIGNS), awning: pick(rng, AWNINGS), doorU, doorW: 2, floor: pick(rng, [B.PLANKS, B.TILE_WHITE]), interiorDepth: Math.min(5, F.D - 4), shelf: hollowB ? 0 : undefined });
  } else {
    entrance(bp, F, doorU, 1, 0, 2, B.PLANKS, B.PLANKS);
    // stoop
    bp.fillR(F.rect(doorU - 1, -1, doorU + 2, 0), RY, RY + 1, pal.trim);
  }
  // fire escape on a side street facade
  const feSide = [1, 3, 0, 2].find((s) => (sides & (1 << s)) && s !== L.front);
  if (feSide !== undefined && top - CL >= 12) {
    const Fs = new Frame(L, feSide);
    const u0 = 2, u1 = Math.min(Fs.W - 2, 7);
    for (let y = CL + 4; y < top - 2; y += 4) {
      bp.fillR(Fs.rect(u0, -1, u1, 0), y, y + 1, B.METAL);
      // ladder rungs (offset each floor)
      const lu = ((y - CL) / 4) % 2 === 0 ? u0 : u1 - 1;
      bp.fillR(Fs.rect(lu, -1, lu + 1, 0), y + 1, y + 2, B.METAL);
    }
  }
  const kinds = pick(rng, [['tower', 'vent'], ['ac', 'vent'], ['tower', 'ac'], ['housing', 'ac'], ['garden', 'vent']]);
  roofDetails(bp, [L.x0, L.z0, L.x1, L.z1], top, kinds, avoid);
  // brick chimney
  if (rng() < 0.6) {
    const r = F.rect(F.W - 2, 1, F.W - 1, 2);
    bp.fillR(r, top, Math.min(95, top + 3), B.BRICK);
  }
  bp.roofY = top;
}

// ------------------------------------------------------------------------------------------------
// Houses (residential + farmhouse + safehouse villa)
// ------------------------------------------------------------------------------------------------
const HOUSE_WALLS = [
  { wall: B.PLASTER, trim: B.PLANKS, roof: B.TERRACOTTA, color: 0xa0583a },
  { wall: B.PLANKS, trim: B.LOG, roof: B.TERRACOTTA, color: 0xa0583a },
  { wall: B.BRICK, trim: B.CONCRETE, roof: B.PLANKS, color: 0xa8854e },
  { wall: B.STUCCO_TEAL, trim: B.TILE_WHITE, roof: B.TERRACOTTA, color: 0xa0583a },
  { wall: B.STUCCO_PINK, trim: B.TILE_WHITE, roof: B.TERRACOTTA, color: 0xa0583a },
  { wall: B.SANDSTONE, trim: B.PLANKS, roof: B.PLANKS, color: 0xa8854e },
  { wall: B.WOOL_WHITE, trim: B.PLANKS, roof: B.COBBLESTONE, color: 0x727272 },
];

export function buildHouse(bp, opts = {}) {
  const L = bp.lot, rng = bp.rng;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const pal = opts.pal || pick(rng, HOUSE_WALLS);
  // yard
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.GRASS);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x5c9a3c);
  const hw = W >= 14 ? Math.min(W - 6, 12) : W - 4;
  const hd = D >= 14 ? Math.min(D - 6, 9) : D - 4;
  const u0 = 1, u1 = u0 + hw, v0 = 2, v1 = v0 + hd;
  const storeys = opts.storeys || (L.height >= 9 ? 2 : 1);
  const y1 = CL + storeys * 4;
  const fpR = F.rect(u0, v0, u1, v1);
  const box = { x0: fpR[0], z0: fpR[1], x1: fpR[2], z1: fpR[3], y0: CL, y1 };
  const st = {
    wall: pal.wall, corner: pal.trim, band: 0, win: B.GLASS, lit: B.GLASS, litP: 0, fh: 4, rows: 0b0110, per: 3, mask: 0b010, off: 0,
    fill: B.PLANKS, roof: B.PLANKS, parapet: 0, salt: L.seed,
  };
  bp.facade(box, st);
  bp.op(box.x0, box.z0, box.x1, box.z1, (c) => hollow(c, box, { fh: 4, slab: B.PLANKS, floor: B.PLANKS, furnish: 0.45, salt: L.seed }));
  // door + path
  const doorU = opts.doorU !== undefined ? opts.doorU : u0 + 2;
  const dx = F.x(doorU, v0), dz = F.z(doorU, v0);
  bp.fill(dx, CL, dz, dx + 1, CL + 2, dz + 1, B.AIR);
  bp.fillR(F.rect(doorU, 0, doorU + 1, v0), RY, RY + 1, opts.path || B.GRAVEL);
  bp.door(F, doorU, 0, 1);
  // roof
  const flat = opts.flat || (pal.roof === B.COBBLESTONE && rng() < 0.5);
  let roofTop = y1;
  if (flat) {
    bp.fill(box.x0, y1, box.z0, box.x1, y1 + 1, box.z1, pal.trim);
    bp.fill(box.x0 + 1, y1, box.z0 + 1, box.x1 - 1, y1 + 1, box.z1 - 1, B.AIR);
    bp.paint(box.x0, box.z0, box.x1, box.z1, 0x8e8e8a, y1 - CL, 'roof');
  } else {
    let k = 0;
    for (; ; k++) {
      const r = [box.x0 - 1 + k, box.z0 - 1 + k, box.x1 + 1 - k, box.z1 + 1 - k];
      if (r[2] - r[0] < 1 || r[3] - r[1] < 1 || y1 + k > 94) break;
      bp.fill(r[0], y1 - 1 + k, r[1], r[2], y1 + k, r[3], pal.roof);
      if (k > 0) bp.fill(r[0] + 1, y1 - 1 + k, r[1] + 1, r[2] - 1, y1 + k, r[3] - 1, pal.roof);
    }
    roofTop = y1 + k - 1;
    bp.paint(box.x0 - 1, box.z0 - 1, box.x1 + 1, box.z1 + 1, shade(pal.color, 1.0), roofTop - CL, 'roof');
    bp.paint(box.x0 + 1, box.z0 + 1, box.x1 - 1, box.z1 - 1, shade(pal.color, 1.12), roofTop - CL, 'roof');
    if (rng() < 0.5) { const cr = F.rect(u1 - 2, v1 - 2, u1 - 1, v1 - 1); bp.fillR(cr, y1, Math.min(95, y1 + Math.ceil(Math.min(hw, hd) / 2) + 1), B.BRICK); }
  }
  // driveway (right side) + parking spot
  if (W - u1 >= 3) {
    const dr = F.rect(u1 + (W - u1 - 3), 0, W, D - 1);
    bp.fillR(dr, RY, RY + 1, B.CONCRETE);
    bp.paintR(dr, 0xb2b0a8);
    const uc = u1 + (W - u1 - 3) + 1.5;
    bp.spot(F.px(uc, 3.0), F.pz(uc, 3.0), F.yawIn, 'driveway');
    bp.keepClear(F.rect(u1 + (W - u1 - 3), -3, W, 0));
  }
  // hedges along the lot edges (not over the path / driveway)
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let u = 0; u < W; u++) {
      if (u === doorU || u >= u1) continue;
      setv(c, F.x(u, 0), CL, F.z(u, 0), B.HEDGE);
    }
    for (let v = 1; v < D; v++) {
      if (u1 < W - 3) setv(c, F.x(W - 1, v), CL, F.z(W - 1, v), B.HEDGE);
      setv(c, F.x(0, v), CL, F.z(0, v), B.HEDGE);
    }
    for (let u = 0; u < W; u++) if (D > hd + 3) setv(c, F.x(u, D - 1), CL, F.z(u, D - 1), B.HEDGE);
    // flower bed along the front of the house
    for (let u = u0; u < u1; u++) {
      if (u === doorU) continue;
      setv(c, F.x(u, v0 - 1), CL, F.z(u, v0 - 1), h3(u, L.x0, L.z0, 5) < 0.5 ? B.FLOWER_RED : B.FLOWER_YELLOW);
    }
  });
  // back yard: tree or pool
  const backD = D - v1 - 1;
  if (backD >= 4 && opts.pool !== false && (opts.pool || rng() < 0.3)) {
    const pr = F.rect(u0 + 1, v1 + 1, Math.min(W - 1, u0 + 1 + 5), v1 + 1 + Math.min(4, backD - 1));
    bp.fill(pr[0] - 0, RY - 2, pr[1], pr[2], RY + 1, pr[3], B.TILE_WHITE);
    bp.fill(pr[0] + 1, RY - 1, pr[1] + 1, pr[2] - 1, RY + 1, pr[3] - 1, B.WATER);
    bp.wet(pr[0] + 1, pr[1] + 1, pr[2] - 1, pr[3] - 1);
    bp.paint(pr[0] + 1, pr[1] + 1, pr[2] - 1, pr[3] - 1, 0x4fb3e0);
    bp.paint(pr[0], pr[1], pr[2], pr[1] + 1, 0xe6e6e1);
  } else if (backD >= 2 || W >= 14) {
    const tu = W >= 14 ? W - 3 : u0 + 1, tv = backD >= 2 ? D - 2 : 1;
    if (!(tu >= u1 && W - u1 >= 3)) bp.feature(feat(F_OAK, F.x(tu, tv), F.z(tu, tv), CL, 4 + Math.floor(rng() * 2), 2, 3));
  }
  if (opts.lamp) bp.feature(feat(F_PARKLAMP, F.x(doorU + 1, 0), F.z(doorU + 1, 0), CL, 0, 0, 0));
  bp.roofY = roofTop;
  return { F, box, u0, u1, v0, v1 };
}

/** The player's safehouse: a modern two-storey villa with big windows, a carport and a roof terrace. */
export function buildSafehouse(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.GRASS);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x5c9a3c);
  const doorU = F.uOf(L.door !== undefined ? L.door : 0, L.door !== undefined ? L.door : 0);
  // main volume (white plaster + glass) and a wood-clad upper box
  const u0 = 1, u1 = Math.min(W - 6, 15), v0 = 2, v1 = D - 1;
  const r1 = F.rect(u0, v0, u1, v1);
  const b1 = { x0: r1[0], z0: r1[1], x1: r1[2], z1: r1[3], y0: CL, y1: CL + 4 };
  bp.facade(b1, { wall: B.PLASTER, corner: B.CONCRETE_DARK, band: 0, win: B.GLASS, lit: B.GLASS, litP: 0, fh: 4, rows: 0b0111, per: 4, mask: 0b0111, off: 1, fill: B.PLANKS, roof: B.CONCRETE, parapet: 0, salt: L.seed });
  const r2 = F.rect(u0 + 2, v0 + 1, u1, v1);
  const b2 = { x0: r2[0], z0: r2[1], x1: r2[2], z1: r2[3], y0: CL + 4, y1: CL + 8 };
  bp.facade(b2, { wall: B.PLANKS, corner: B.CONCRETE_DARK, band: 0, win: B.GLASS, lit: B.GLASS, litP: 0, fh: 4, rows: 0b0110, per: 3, mask: 0b011, off: 0, fill: B.PLANKS, roof: B.CONCRETE, parapet: B.CONCRETE_DARK, salt: L.seed });
  bp.op(b1.x0, b1.z0, b1.x1, b1.z1, (c) => hollow(c, b1, { fh: 4, slab: B.PLANKS, floor: B.MARBLE, furnish: true, salt: L.seed }));
  bp.op(b2.x0, b2.z0, b2.x1, b2.z1, (c) => hollow(c, { ...b2, y0: CL + 4 }, { fh: 4, slab: B.PLANKS, floor: B.PLANKS, fromY: CL + 4, furnish: true, salt: L.seed + 1 }));
  // roof terrace on the lower volume front part
  const tr = F.rect(u0, v0, u0 + 2, v1);
  bp.fillR(tr, CL + 4, CL + 5, B.HEDGE);
  // front door
  const dx = F.x(doorU, v0), dz = F.z(doorU, v0);
  bp.fill(dx, CL, dz, dx + 1, CL + 3, dz + 1, B.AIR);
  bp.fillR(F.rect(doorU, 0, doorU + 1, v0), RY, RY + 1, B.SIDEWALK);
  bp.set(F.x(doorU - 1, v0 - 1), CL, F.z(doorU - 1, v0 - 1), B.LAMP);
  bp.set(F.x(doorU + 1, v0 - 1), CL, F.z(doorU + 1, v0 - 1), B.LAMP);
  // carport with a car spot on the right, open to the street
  const cr = F.rect(u1 + 1, 0, W, D - 1);
  bp.fillR(cr, RY, RY + 1, B.CONCRETE);
  bp.fillR(F.rect(u1 + 1, 3, W, D - 1), CL + 3, CL + 4, B.CONCRETE_DARK);
  bp.fillR(F.rect(W - 1, 3, W, 4), CL, CL + 3, B.METAL);
  bp.fillR(F.rect(W - 1, D - 2, W, D - 1), CL, CL + 3, B.METAL);
  const uc = u1 + 1 + (W - u1 - 1) / 2;
  bp.spot(F.px(uc, 4.5), F.pz(uc, 4.5), F.yawIn, 'safehouse');
  bp.keepClear(F.rect(u1, -3, W, 0));
  // hedges + flowers
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let u = 0; u <= u1; u++) {
      if (Math.abs(u - doorU) <= 0) continue;
      setv(c, F.x(u, 0), CL, F.z(u, 0), u % 3 === 0 ? B.FLOWER_RED : B.HEDGE);
    }
  });
  bp.paint(b1.x0, b1.z0, b1.x1, b1.z1, 0xd9d4c4, 4, 'roof');
  bp.paint(b2.x0, b2.z0, b2.x1, b2.z1, 0xa8854e, 8, 'roof');
  bp.paintR(cr, 0x55555a, 3, 'roof');
  bp.roofY = CL + 8;
}

// ------------------------------------------------------------------------------------------------
// POI buildings
// ------------------------------------------------------------------------------------------------
export function buildHospital(bp) {
  const L = bp.lot, rng = bp.rng;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const doorU = F.uOf(L.door, L.door);
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0xc8c6be);
  const top = CL + 20;
  const r = F.rect(0, 3, W, D);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.facade(box, { wall: B.TILE_WHITE, corner: B.WOOL_WHITE, band: B.WOOL_WHITE, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.55, fh: 4, rows: 0b0110, per: 1, mask: 1, fill: B.CONCRETE, roof: B.CONCRETE, parapet: B.WOOL_WHITE, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], 0xf0eeea, top - CL, 'roof');
  // big red cross on the facade (white backing)
  const cu = doorU, cy = top - 7;
  bp.op(Math.min(F.x(cu - 4, 3), F.x(cu + 4, 3)), Math.min(F.z(cu - 4, 3), F.z(cu + 4, 3)), Math.max(F.x(cu - 4, 3), F.x(cu + 4, 3)) + 1, Math.max(F.z(cu - 4, 3), F.z(cu + 4, 3)) + 1, (c) => {
    for (let du = -4; du <= 4; du++) for (let dy = -4; dy <= 4; dy++) {
      const red = (Math.abs(du) <= 1 && Math.abs(dy) <= 3) || (Math.abs(dy) <= 1 && Math.abs(du) <= 3);
      setv(c, F.x(cu + du, 3), cy + dy, F.z(cu + du, 3), red ? B.WOOL_RED : B.WOOL_WHITE);
    }
  });
  // roof cross + helipad
  const rc = [r[0] + 3, r[1] + 3, r[2] - 3, r[3] - 3];
  helipad(bp, rc, top - 1);
  bp.op(rc[0], rc[1], rc[2], rc[3], (c) => {
    const mx = (rc[0] + rc[2]) >> 1, mz = (rc[1] + rc[3]) >> 1;
    for (let k = -4; k <= 4; k++) { setv(c, mx + k, top - 1, mz, B.WOOL_RED); setv(c, mx, top - 1, mz + k, B.WOOL_RED); }
  });
  bp.paint(rc[0], rc[1], rc[2], rc[3], 0x5c5d60, top - CL, 'roof');
  bp.paint(((rc[0] + rc[2]) >> 1) - 4, ((rc[1] + rc[3]) >> 1), ((rc[0] + rc[2]) >> 1) + 5, ((rc[1] + rc[3]) >> 1) + 1, 0xd03030, top - CL, 'roof');
  bp.paint(((rc[0] + rc[2]) >> 1), ((rc[1] + rc[3]) >> 1) - 4, ((rc[0] + rc[2]) >> 1) + 1, ((rc[1] + rc[3]) >> 1) + 5, 0xd03030, top - CL, 'roof');
  // entrance: glass lobby, wide doors, canopy on pillars over the drop-off
  storefront(bp, F, 0, W, 3, { wall: B.WOOL_WHITE, glass: B.GLASS, doorU: doorU - 1, doorW: 3, floor: B.TILE_WHITE, interiorDepth: 7, shelf: 0, sign: B.NEON_PINK, noAwning: true });
  bp.fillR(F.rect(doorU - 4, 0, doorU + 5, 3), CL + 3, CL + 4, B.WOOL_WHITE);
  bp.fillR(F.rect(doorU - 4, 0, doorU - 3, 1), CL, CL + 3, B.METAL);
  bp.fillR(F.rect(doorU + 4, 0, doorU + 5, 1), CL, CL + 3, B.METAL);
  bp.fillR(F.rect(doorU - 3, 0, doorU + 4, 0 + 3), RY, RY + 1, B.TILE_WHITE);
  // ambulance bays along the front
  bp.spot(F.px(2.5, 1.5), F.pz(2.5, 1.5), F.yawIn + Math.PI / 2, 'ambulance');
  bp.spot(F.px(W - 2.5, 1.5), F.pz(W - 2.5, 1.5), F.yawIn - Math.PI / 2, 'ambulance');
  bp.keepClear(F.rect(0, -3, 4, 0));
  bp.keepClear(F.rect(W - 4, -3, W, 0));
  bp.fillR(F.rect(0, 0, W, 3), RY, RY + 1, B.CONCRETE);
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => { for (let u = 0; u < W; u += 2) setv(c, F.x(u, 2), RY, F.z(u, 2), B.ROAD_LINE_WHITE); });
  roofDetails(bp, [r[0], r[1], r[2], r[3]], top, ['ac', 'ac', 'vent'], rc);
  bp.roofY = top;
  void rng;
}

export function buildPolice(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const doorU = F.uOf(L.door, L.door);
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x4a4b50);
  const top = CL + 16;
  const r = F.rect(0, 0, W, 13);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.facade(box, { wall: B.CONCRETE, corner: B.WOOL_BLUE, band: B.WOOL_BLUE, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.6, fh: 4, rows: 0b0110, per: 3, mask: 0b011, off: 1, fill: B.CONCRETE, roof: B.ROOF, parapet: B.WOOL_BLUE, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], 0x3c44aa, top - CL, 'roof');
  storefront(bp, F, 0, W, 0, { wall: B.WOOL_BLUE, glass: B.GLASS, doorU: doorU - 1, doorW: 3, floor: B.TILE_WHITE, interiorDepth: 6, shelf: B.METAL, sign: B.NEON_BLUE, noAwning: true, counter: B.WOOL_BLUE });
  // blue & red lights by the door + steps
  const lx1 = F.x(doorU - 3, -1), lz1 = F.z(doorU - 3, -1), lx2 = F.x(doorU + 3, -1), lz2 = F.z(doorU + 3, -1);
  bp.set(lx1, CL + 2, lz1, B.NEON_BLUE); bp.set(lx2, CL + 2, lz2, B.NEON_PINK);
  bp.fillR(F.rect(doorU - 2, -1, doorU + 3, 0), CL + 3, CL + 4, B.CONCRETE);
  // flag on the roof
  const fx = F.x(2, 2), fz = F.z(2, 2);
  bp.fill(fx, top, fz, fx + 1, top + 7, fz + 1, B.METAL);
  const fr = F.rect(3, 2, 6, 3);
  bp.fillR(fr, top + 5, top + 7, B.WOOL_BLUE);
  bp.set(F.x(4, 2), top + 6, F.z(4, 2), B.WOOL_WHITE);
  // antenna + siren lights
  bp.fill(F.x(W - 3, 6), top, F.z(W - 3, 6), F.x(W - 3, 6) + 1, top + 9, F.z(W - 3, 6) + 1, B.METAL);
  bp.set(F.x(W - 3, 6), top + 9, F.z(W - 3, 6), B.NEON_PINK);
  roofDetails(bp, r, top, ['ac', 'housing'], F.rect(0, 0, 8, 5));
  // rear yard: police parking off the back street, low wall with a gate
  const yard = F.rect(0, 13, W, D);
  bp.fillR(yard, RY, RY + 1, B.ASPHALT);
  bp.paintR(yard, 0x3d3d42);
  bp.op(yard[0], yard[1], yard[2], yard[3], (c) => {
    for (let u = 0; u < W; u++) {
      setv(c, F.x(u, 13), RY, F.z(u, 13), B.ROAD_LINE_WHITE);
      if (u % 4 === 0) for (let v = 14; v < D - 1; v++) setv(c, F.x(u, v), RY, F.z(u, v), B.ROAD_LINE_WHITE);
    }
  });
  for (let k = 0; k < 4; k++) {
    const uc = 2 + k * 4;
    if (uc + 2 > W) break;
    bp.spot(F.px(uc + 0.5 - 0.5 + 1, 16.5), F.pz(uc + 1, 16.5), F.yawOut, 'police');
  }
  bp.keepClear(F.rect(0, D, W, D + 3));
  bp.roofY = top;
}

export function buildGunshop(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const doorU = F.uOf(L.door, L.door);
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  const top = CL + 8;
  const box = { x0: L.x0, z0: L.z0, x1: L.x1, z1: L.z1, y0: CL, y1: top };
  bp.facade(box, { wall: B.WOOL_RED, corner: B.WOOL_BLACK, band: B.WOOL_BLACK, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.5, fh: 2, rows: 0b10, per: 2, mask: 0b01, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.WOOL_BLACK, salt: L.seed });
  // bold stripes: alternate red/black every row on all walls (overrides window rows above the shop)
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let y = CL + 4; y < top; y++) {
      const id = ((y >> 1) % 2 === 0) ? B.WOOL_RED : B.WOOL_BLACK;
      for (let x = L.x0; x < L.x1; x++) { setv(c, x, y, L.z0, id); setv(c, x, y, L.z1 - 1, id); }
      for (let z = L.z0; z < L.z1; z++) { setv(c, L.x0, y, z, id); setv(c, L.x1 - 1, y, z, id); }
    }
  });
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0x8a2a24, top - CL, 'roof');
  storefront(bp, F, 0, W, 0, { wall: B.WOOL_BLACK, glass: B.GLASS, doorU: doorU - 1, doorW: 2, floor: B.CARPET_RED, interiorDepth: D - 3, shelf: B.METAL, sign: B.NEON_PINK, sign2: B.WOOL_BLACK, awning: [B.WOOL_RED, B.WOOL_BLACK], counter: B.WOOL_BLACK });
  // security bars on the display windows
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let u = 1; u < W - 1; u += 2) {
      if (u >= doorU - 1 && u <= doorU) continue;
      setv(c, F.x(u, 0), CL + 1, F.z(u, 0), B.METAL);
    }
  });
  // rooftop sign: white frame, red field, black pistol silhouette
  const sr = F.rect(1, 1, W - 1, 2);
  bp.op(sr[0], sr[1], sr[2], sr[3], (c) => {
    const gun = ['XXXXXX', 'XXXXXX', 'XX....', 'X.....'];
    const bw = W - 2, bh = 6;
    for (let k = 0; k < bw; k++) {
      for (let row = 0; row < bh; row++) {
        const u = 1 + k, y = top + bh - 1 - row;
        const border = k === 0 || k === bw - 1 || row === 0 || row === bh - 1;
        let id = border ? B.WOOL_WHITE : B.WOOL_RED;
        const gx = k - 1 - Math.max(0, Math.floor((bw - 2 - 6) / 2)), gy = row - 1;
        if (!border && gx >= 0 && gx < 6 && gy >= 0 && gy < 4 && gun[gy][gx] === 'X') id = B.WOOL_BLACK;
        setv(c, F.x(u, 1), y, F.z(u, 1), id);
      }
    }
  });
  bp.fillR(F.rect(2, 1, 3, 2), top - 1, top, B.METAL);
  bp.fillR(F.rect(W - 3, 1, W - 2, 2), top - 1, top, B.METAL);
  bp.roofY = top;
}

export function buildHardware(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const doorU = F.uOf(L.door, L.door);
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0xb0aea6);
  const top = CL + 8;
  const r = F.rect(0, 0, 15, D);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.facade(box, { wall: B.WOOL_ORANGE, corner: B.PLANKS, band: B.PLANKS, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.5, fh: 4, rows: 0b0100, per: 3, mask: 0b010, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.PLANKS, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], 0xe0782a, top - CL, 'roof');
  const du = Math.min(doorU, 12) - 1;
  storefront(bp, F, 0, 15, 0, { wall: B.PLANKS, glass: B.GLASS, doorU: du, doorW: 3, floor: B.PLANKS, interiorDepth: D - 3, shelf: B.CRATE, sign: B.LAMP, awning: [B.WOOL_ORANGE, B.WOOL_WHITE], counter: B.WOOL_ORANGE });
  // big sign board on the roof edge
  bp.fillR(F.rect(2, 0, 13, 1), top, top + 3, B.WOOL_WHITE);
  bp.fillR(F.rect(2, 0, 13, 1), top + 3, top + 4, B.WOOL_ORANGE);
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    // a pickaxe pictogram
    const pic = ['XXXXX', '..X..', '..X..'];
    for (let row = 0; row < 3; row++) for (let k = 0; k < 5; k++) if (pic[row][k] === 'X') setv(c, F.x(5 + k, 0), top + 2 - row, F.z(5 + k, 0), B.WOOL_BLACK);
  });
  // garden centre yard on the side: hedges, flowers, crates, saplings
  const gy = F.rect(15, 0, W, D);
  bp.fillR(gy, RY, RY + 1, B.GRAVEL);
  bp.paintR(gy, 0x7a9a50);
  bp.op(gy[0], gy[1], gy[2], gy[3], (c) => {
    for (let v = 0; v < D; v++) for (let u = 15; u < W; u++) {
      const x = F.x(u, v), z = F.z(u, v);
      const edge = u === W - 1 || v === D - 1 || (v === 0 && u !== 16 && u !== 17);
      if (edge) { setv(c, x, CL, z, B.HEDGE); continue; }
      const hsh = h3(x, 1, z, 33);
      if (v % 4 === 2 && u > 15) setv(c, x, CL, z, hsh < 0.5 ? B.FLOWER_RED : B.FLOWER_YELLOW);
      else if (v % 4 === 0 && hsh < 0.35) { setv(c, x, CL, z, B.CRATE); if (hsh < 0.12) setv(c, x, CL + 1, z, B.CRATE); }
      else if (hsh > 0.93) setv(c, x, CL, z, B.LEAVES);
    }
  });
  bp.roofY = top;
}

export function buildGarage(bp) {
  const L = bp.lot;
  const F = new Frame(L);
  const W = F.W, D = F.D;
  const doorU = F.uOf(L.door, L.door);
  bp.fill(L.x0, RY, L.z0, L.x1, RY + 1, L.z1, B.CONCRETE);
  bp.paint(L.x0, L.z0, L.x1, L.z1, 0xa0a09a);
  const top = CL + 8;
  const r = F.rect(1, 4, W - 1, D - 1);
  const box = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.facade(box, { wall: B.CONCRETE_DARK, corner: B.METAL, band: B.METAL, win: B.WINDOW, lit: B.WINDOW_LIT, litP: 0.6, fh: 4, rows: 0b0100, per: 2, mask: 0b01, off: 0, fill: B.CONCRETE, roof: B.ROOF, parapet: B.HAZARD, salt: L.seed });
  bp.paint(r[0], r[1], r[2], r[3], 0x55565b, top - CL, 'roof');
  // hollow workshop
  const inner = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y0: CL, y1: top };
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    fillBox(c, r[0] + 1, CL, r[1] + 1, r[2] - 1, top - 2, r[3] - 1, B.AIR);
    fillBox(c, r[0] + 1, RY, r[1] + 1, r[2] - 1, RY + 1, r[3] - 1, B.CONCRETE);
    for (let x = r[0] + 2; x < r[2] - 1; x += 4) for (let z = r[1] + 2; z < r[3] - 1; z += 4) setv(c, x, top - 2, z, B.LAMP);
  });
  void inner;
  // the bay: 7 wide x 5 high opening framed with hazard stripes
  const b0 = doorU - 3, b1 = doorU + 4;
  bp.fillR(F.rect(b0, 4, b1, 5), CL, CL + 5, B.AIR);
  bp.fillR(F.rect(b0 - 1, 4, b0, 5), CL, CL + 6, B.HAZARD);
  bp.fillR(F.rect(b1, 4, b1 + 1, 5), CL, CL + 6, B.HAZARD);
  bp.fillR(F.rect(b0 - 1, 4, b1 + 1, 5), CL + 5, CL + 6, B.HAZARD);
  bp.fillR(F.rect(b0 - 1, 4, b1 + 1, 5), CL + 6, CL + 7, B.NEON_BLUE);
  // spray booth walls inside (white) + nozzles
  bp.op(r[0], r[1], r[2], r[3], (c) => {
    for (let v = 6; v < D - 2; v++) {
      for (const u of [b0 - 1, b1]) {
        if (u <= 1 || u >= W - 2) continue;
        for (let y = CL; y < CL + 5; y++) setv(c, F.x(u, v), y, F.z(u, v), B.WOOL_WHITE);
        if (v % 3 === 0) setv(c, F.x(u, v), CL + 3, F.z(u, v), B.METAL);
      }
    }
    for (let u = b0; u < b1; u++) setv(c, F.x(u, D - 3), CL + 4, F.z(u, D - 3), B.METAL);
  });
  // apron with hazard chevrons
  bp.op(L.x0, L.z0, L.x1, L.z1, (c) => {
    for (let v = 0; v < 4; v++) for (let u = b0; u < b1; u++) {
      if ((u + v) % 3 === 0) setv(c, F.x(u, v), RY, F.z(u, v), B.HAZARD);
    }
    for (let v = 5; v < D - 2; v++) { setv(c, F.x(b0, v), RY, F.z(b0, v), B.ROAD_LINE_YELLOW); setv(c, F.x(b1 - 1, v), RY, F.z(b1 - 1, v), B.ROAD_LINE_YELLOW); }
  });
  bp.keepClear(F.rect(b0 - 2, -3, b1 + 2, 0));
  // customer parking on the apron sides
  bp.spot(F.px(2, 2), F.pz(2, 2), F.yawIn + Math.PI / 2, 'garage');
  bp.roofY = top;
}

