// Chapter 3: Iron Lotus Gym. Raw concrete, red mats, punching bags on steel beams, weight racks, wooden dummies.
// Light comes down through skylights: real sun patches cut by the roof (shadow-casting ceiling), no shafts/fog.
import { MeshBuilder, mix, lin, cylGeo } from '../geo.js';
import { wallSide, side, sideBox, slots, corridorShell, ceiling, inDoorway } from '../kit.js';
import { Local, plant, crate } from '../props.js';

const DOOR_H = 2.8;
const C = {
  concrete: 0xc4bfb5, concreteB: 0xb6b1a7, joint: 0xa6a197, floor: 0xc6c1b8, floorB: 0xbdb8ae,
  mat: 0xcf5446, matB: 0xc84e41, matLine: 0xf2ece0, matBlue: 0x3d5a80,
  steel: 0x3d4347, beam: 0x8a2f2a, chain: 0x5a5f63, leather: 0x3a2f2c, bagRed: 0x9a2f29, tape: 0xe9e1cf,
  rack: 0x2f3437, plate: 0x26292c, plateRim: [0xc7443a, 0x3d6fa0, 0xe0a33d, 0x4f8a55], chrome: 0xb9c0c4,
  wood: 0x9b6a3f, woodDark: 0x6e4a2c, locker: 0x7d958a, lockerB: 0x6f877c, pad: 0xa8352e,
  ceiling: 0xd9d6cf, glassSky: 0xcfe3ee, gold: 0xd9a441, banner: 0xb3312a, white: 0xf3efe6,
};

export const light = {
  sunDir: [0.42, 0.86, -0.28], sun: 0xfff1d8, sunI: 3.6,
  hemiSky: 0xdfe3e4, hemiGround: 0xc4b2a6, hemiI: 1.4, exposure: 1.0,
  sky: { top: 0x86b5de, mid: 0xc6dcec, horizon: 0xece6dc, bottom: 0xd8d0c4, sun: 0xfff4de, sunSize: 0.0016, halo: 0.9, midH: 0.3 },
};

const L = new Local();
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const ao = (a, min = 0.78) => (x, z) => { const w = a.wall; const d = Math.min(x - w.minX, w.maxX - x, z - w.minZ, w.maxZ - z); return min + (1 - min) * smooth(0, 1.1, d); };

// ------------------------------------------------------------------ props

function heavyBag(b, x, z, top, rng) {
  const col = rng() < 0.5 ? C.leather : C.bagRed;
  b.cyl(x, 0.55, z, 0.2, 1.15, col, { seg: 10 });
  b.cyl(x, 1.7, z, 0.17, 0.08, mix(col, 0x000000, 0.3), { seg: 10 });
  b.cyl(x, 0.52, z, 0.17, 0.05, mix(col, 0x000000, 0.3), { seg: 10 });
  b.cyl(x, 1.1, z, 0.205, 0.12, C.tape, { seg: 10 });
  b.bar(x, 1.78, z, x, top, z, 0.012, C.chain, 4);
}

function dumbbellRack(B, x, z, yaw, rng) {
  const b = B.m;
  L.set(x, z, yaw);
  for (const sx of [-0.85, 0.85]) { L.box(b, sx, 0, 0, 0.06, 0.85, 0.6, C.rack); }
  L.box(b, 0, 0.45, -0.1, 1.76, 0.05, 0.28, C.rack, { rx: -0.2 });
  L.box(b, 0, 0.8, 0.05, 1.76, 0.05, 0.28, C.rack, { rx: -0.2 });
  for (const [y, zz] of [[0.52, -0.1], [0.87, 0.05]]) {
    for (let i = 0; i < 6; i++) {
      const u = -0.72 + i * 0.29;
      L.bar(b, u - 0.1, y, zz, u + 0.1, y, zz, 0.018, C.chrome, 6);
      L.disc(b, u - 0.1, y, zz, 0.06 + i * 0.006, 0.05, C.plate, 8);
      L.disc(b, u + 0.1, y, zz, 0.06 + i * 0.006, 0.05, C.plate, 8);
    }
  }
}

/** Plate disc standing on edge, axis along the local X of `yaw`. */
function plate(b, x, y, z, r, yaw, col) {
  b.geom(cylGeo(14), MeshBuilder.mat(x, y, z, 0, yaw, Math.PI / 2, r, 0.05, r), col);
}

function squatRack(B, x, z, yaw, rng) {
  const b = B.m;
  L.set(x, z, yaw);
  for (const sx of [-0.6, 0.6]) for (const sz of [-0.35, 0.35]) L.box(b, sx, 0, sz, 0.07, 2.3, 0.07, C.rack);
  for (const sz of [-0.35, 0.35]) L.box(b, 0, 2.25, sz, 1.27, 0.07, 0.07, C.rack);
  L.box(b, 0, 0, 0, 1.4, 0.04, 0.9, 0x2a2d2f);
  // barbell on the hooks
  L.bar(b, -1.05, 1.35, 0.35, 1.05, 1.35, 0.35, 0.02, C.chrome, 6);
  for (const s of [-1, 1]) {
    const col = pick(rng, C.plateRim);
    for (let k = 0; k < 2; k++) {
      const px = L.px(s * (0.78 + k * 0.06), 0.35), pz = L.pz(s * (0.78 + k * 0.06), 0.35);
      plate(b, px, 1.35, pz, 0.22 - k * 0.04, yaw, k ? C.plate : col);
    }
  }
}

function bench(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0.42, 0, 0.3, 0.1, 1.2, 0x2a2d2f);
  L.box(b, 0, 0, -0.45, 0.06, 0.42, 0.06, C.rack);
  L.box(b, 0, 0, 0.45, 0.06, 0.42, 0.06, C.rack);
  L.box(b, 0, 0, -0.45, 0.4, 0.05, 0.06, C.rack);
  L.box(b, 0, 0, 0.45, 0.4, 0.05, 0.06, C.rack);
}

function plateStack(b, x, z, rng) {
  for (let k = 0; k < 5; k++) b.cyl(x, k * 0.055, z, 0.23 - k * 0.012, 0.05, k % 2 ? C.plate : pick(rng, C.plateRim), { seg: 14 });
}

function kettlebell(b, x, z, s, col) {
  b.blob(x, 0.13 * s, z, 0.14 * s, 0.13 * s, 0.14 * s, col, 1);
  b.box(x, 0.24 * s, z, 0.2 * s, 0.05 * s, 0.04 * s, col);
}

function locker(B, x, z, yaw, i) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 0.45, 1.9, 0.5, i % 2 ? C.locker : C.lockerB, { top: 0x6a8076 });
  for (let k = 0; k < 4; k++) L.box(b, 0, 1.45 + k * 0.06, 0.253, 0.3, 0.02, 0.01, 0x55665e);
  L.box(b, 0.15, 0.95, 0.255, 0.03, 0.12, 0.02, C.chrome);
}

function woodenDummy(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.cyl(b, 0, 0, 0, 0.14, 1.65, C.wood, { seg: 10 });
  L.cyl(b, 0, 1.65, 0, 0.12, 0.05, C.woodDark, { seg: 10 });
  // arms + leg
  L.bar(b, -0.06, 1.25, 0.05, -0.22, 1.32, 0.48, 0.03, C.woodDark, 6);
  L.bar(b, 0.06, 1.25, 0.05, 0.22, 1.32, 0.48, 0.03, C.woodDark, 6);
  L.bar(b, 0, 0.98, 0.05, 0, 0.98, 0.5, 0.03, C.woodDark, 6);
  L.bar(b, 0, 0.45, 0.05, 0.05, 0.25, 0.45, 0.04, C.woodDark, 6);
  // frame
  for (const sx of [-0.3, 0.3]) L.box(b, sx, 0, -0.12, 0.06, 1.9, 0.06, C.woodDark);
  L.box(b, 0, 1.85, -0.12, 0.66, 0.06, 0.06, C.woodDark);
  L.box(b, 0, 0.3, -0.12, 0.66, 0.06, 0.06, C.woodDark);
}

function weaponRack(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0.1, 0, 1.4, 0.08, 0.2, C.woodDark);
  L.box(b, 0, 1.5, 0, 1.4, 0.08, 0.2, C.woodDark);
  for (let k = 0; k < 6; k++) L.cyl(b, -0.6 + k * 0.24, 0.05, 0.02, 0.022, 1.9, k % 3 === 0 ? 0xc79a6a : C.wood, { seg: 5 });
}

function bleachers(B, x, z, yaw, len) {
  const b = B.m;
  L.set(x, z, yaw);
  for (let r = 0; r < 3; r++) {
    L.box(b, 0, 0, 0.45 - r * 0.45, len, 0.42 + r * 0.42, 0.45, r % 2 ? 0x8f969b : 0x7f878c, { top: r % 2 ? 0xc79a6a : 0xb7865a });
  }
}

function banner(b, sd, u, y0, h) {
  sideBox(b, sd, u - 0.55, u + 0.55, -0.06, -0.02, y0, y0 + h, C.banner);
  sideBox(b, sd, u - 0.6, u + 0.6, -0.08, -0.02, y0 + h, y0 + h + 0.06, C.gold);
  // stylised lotus: three petals
  const p = (du, dy, w, hh) => sideBox(b, sd, u + du - w / 2, u + du + w / 2, -0.07, -0.06, y0 + dy, y0 + dy + hh, C.gold);
  p(0, h * 0.42, 0.18, 0.38); p(-0.16, h * 0.38, 0.12, 0.26); p(0.16, h * 0.38, 0.12, 0.26); p(0, h * 0.34, 0.5, 0.05);
}

// ------------------------------------------------------------------ shells

function concreteWalls(b, a, H) {
  b.setAO(0.78, 1.6);
  for (const s of ['minZ', 'maxZ', 'minX', 'maxX']) {
    const sd = wallSide(b, a, s, { h: H, color: C.concrete, doorH: DOOR_H, lintel: C.concrete, skirting: 0x8c8880, skirtH: 0.1 });
    // formwork joints
    for (let y = 1.2; y < H - 0.2; y += 1.2) for (const [u0, u1] of segs(sd)) sideBox(b, sd, u0, u1, -0.012, 0, y, y + 0.025, C.joint);
    for (const [u0, u1] of segs(sd)) for (let u = u0 + 1.2; u < u1 - 0.3; u += 2.4) sideBox(b, sd, u, u + 0.025, -0.012, 0, 0, H, C.joint);
  }
  b.noAO();
}
function segs(sd) { const out = []; let cur = sd.from; for (const [o0, o1] of [...sd.openings].sort((p, q) => p[0] - q[0])) { if (o0 > cur) out.push([cur, o0]); cur = Math.max(cur, o1); } if (cur < sd.to) out.push([cur, sd.to]); return out; }

function skylights(a, n) {
  const f = a.floor, out = [];
  const cols = n > 2 ? 2 : 1, rows = Math.ceil(n / cols);
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const cx = f.minX + (f.maxX - f.minX) * ((i + 0.5) / cols), cz = f.minZ + (f.maxZ - f.minZ) * ((j + 0.5) / rows);
    out.push({ minX: cx - 1.3, maxX: cx + 1.3, minZ: cz - 1.6, maxZ: cz + 1.6 });
  }
  return out;
}

function roomShell(B, a, ctx) {
  const b = B.m, w = a.wall, H = a.ceil, f = a.floor;
  // polished concrete (gloss) around, red mats (matte) on the arena
  B.g.floor(w.minX, w.minZ, w.maxX, w.maxZ, 0, 1.0, (ix, iz) => ((ix * 3 + iz * 5) % 7 === 0 ? C.floorB : C.floor), ao(a));
  b.setAO(null);
  const mx0 = f.minX + 0.2, mx1 = f.maxX - 0.2, mz0 = f.minZ + 0.2, mz1 = f.maxZ - 0.2;
  b.floor(mx0, mz0, mx1, mz1, 0.03, 1.0, (ix, iz) => (a.boss ? ((ix + iz) % 2 ? C.mat : C.matB) : (ix + iz) % 2 ? C.mat : C.matB));
  b.boxMM(mx0 - 0.08, 0, mz0 - 0.08, mx1 + 0.08, 0.03, mz0, C.matLine);
  b.boxMM(mx0 - 0.08, 0, mz1, mx1 + 0.08, 0.03, mz1 + 0.08, C.matLine);
  b.boxMM(mx0 - 0.08, 0, mz0, mx0, 0.03, mz1, C.matLine);
  b.boxMM(mx1, 0, mz0, mx1 + 0.08, 0.03, mz1, C.matLine);
  concreteWalls(b, a, H);
  // roof with skylight wells + glazing bars
  const holes = skylights(a, a.boss ? 4 : 2);
  b.glow(0.25);
  ceiling(b, { minX: w.minX - 0.3, maxX: w.maxX + 0.3, minZ: w.minZ - 0.3, maxZ: w.maxZ + 0.3 }, H, 0.35, C.ceiling, holes);
  b.glow(0);
  for (const h of holes) {
    b.boxMM(h.minX - 0.1, H, h.minZ - 0.1, h.maxX + 0.1, H + 0.9, h.minZ, 0xe4e1da);
    b.boxMM(h.minX - 0.1, H, h.maxZ, h.maxX + 0.1, H + 0.9, h.maxZ + 0.1, 0xe4e1da);
    b.boxMM(h.minX - 0.1, H, h.minZ, h.minX, H + 0.9, h.maxZ, 0xe4e1da);
    b.boxMM(h.maxX, H, h.minZ, h.maxX + 0.1, H + 0.9, h.maxZ, 0xe4e1da);
    for (let x = h.minX + 0.65; x < h.maxX - 0.1; x += 0.65) b.boxMM(x - 0.03, H + 0.75, h.minZ, x + 0.03, H + 0.82, h.maxZ, C.steel);
    B.gl.boxMM(h.minX, H + 0.84, h.minZ, h.maxX, H + 0.86, h.maxZ, C.glassSky);
  }
  // steel beams across X (paint red), resting on the walls
  const beams = [];
  for (let z = w.minZ + 1.6; z < w.maxZ - 1.0; z += 3.0) {
    if (holes.some((h) => z > h.minZ - 0.2 && z < h.maxZ + 0.2)) continue;
    b.boxMM(w.minX, H - 0.45, z - 0.1, w.maxX, H, z + 0.1, C.beam);
    beams.push(z);
  }
  // clerestory strip on +X: high windows
  const sd = side(a, 'maxX');
  b.glow(0.9);
  sideBox(b, sd, w.minZ + 1.0, w.maxZ - 1.0, -0.01, 0, H - 1.25, H - 0.6, C.glassSky);
  b.glow(0);
  for (let z = w.minZ + 1.0; z <= w.maxZ - 0.99; z += (w.maxZ - w.minZ - 2) / 6) sideBox(b, sd, z - 0.04, z + 0.04, -0.03, 0, H - 1.25, H - 0.6, C.steel);
  // pendant lamps
  b.glow(1.6);
  for (const z of beams) for (const x of [a.center.x - 2.5, a.center.x + 2.5]) {
    b.cyl(x, H - 1.35, z, 0.22, 0.04, 0xfff3d6, { seg: 10 });
    ctx.lights.push({ x, y: H - 1.6, z, color: lin(0xfff0d0), intensity: 0.45, range: 5 });
  }
  b.glow(0);
  for (const z of beams) for (const x of [a.center.x - 2.5, a.center.x + 2.5]) {
    b.cyl(x, H - 1.33, z, 0.24, 0.22, C.steel, { rTop: 0.06, seg: 10 });
    b.bar(x, H - 1.1, z, x, H - 0.45, z, 0.01, C.chain, 4);
  }
  return { beams, H };
}

function dressRoom(B, a, ctx, shell) {
  const { rng } = ctx;
  const b = B.m;
  const { H } = shell;
  const sMaxZ = side(a, 'maxZ'), sMinZ = side(a, 'minZ'), sMinX = side(a, 'minX'), sMaxX = side(a, 'maxX');
  if (a.index === 0) {
    // bag room: rows of heavy bags on both long sides, hung from a rail
    for (const s of ['minX', 'maxX']) {
      const ps = slots(a, s, 1.25, 0.8, 0.8, 0.2);
      const sd = side(a, s);
      const lineX = sd.line - sd.nx * 0.8;
      b.boxMM(lineX - 0.06, H - 0.55, a.wall.minZ + 0.6, lineX + 0.06, H - 0.45, a.wall.maxZ - 0.6, C.steel);
      for (const p of ps) heavyBag(b, p.x, p.z, H - 0.5, rng);
    }
    for (const p of slots(a, 'maxZ', 1.6, 0.5, 0.6)) { kettlebell(b, p.x - 0.2, p.z, 1, C.plate); kettlebell(b, p.x + 0.25, p.z + 0.05, 1.2, C.steel); }
    for (const p of slots(a, 'minZ', 2.2, 0.45, 0.6)) bench(B, p.x, p.z, p.yaw + Math.PI / 2);
    // speed bag platforms
    for (const u of [a.wall.minX + 1.5, a.wall.maxX - 1.5]) {
      sideBox(b, sMaxZ, u - 0.4, u + 0.4, -0.6, 0, 2.05, 2.12, C.woodDark);
      const p = { x: u, z: sMaxZ.line - 0.4 };
      b.blob(p.x, 1.85, p.z, 0.1, 0.14, 0.1, C.bagRed, 1);
    }
    banner(b, sMinX, a.center.z, 2.6, 1.6);
    banner(b, sMaxX, a.center.z, 2.6, 1.6);
  } else if (a.index === 1) {
    // iron floor: dumbbells, squat racks, plates, benches
    for (const p of slots(a, 'minX', 2.1, 0.45, 0.6)) dumbbellRack(B, p.x, p.z, p.yaw, rng);
    for (const p of slots(a, 'maxX', 2.6, 0.75, 0.6)) squatRack(B, p.x, p.z, p.yaw, rng);
    slots(a, 'maxZ', 1.3, 0.55, 0.6).forEach((p, k) => (k % 2 ? plateStack(b, p.x, p.z, rng) : bench(B, p.x, p.z, p.yaw)));
    slots(a, 'minZ', 0.9, 0.4, 0.6).forEach((p, k) => kettlebell(b, p.x, p.z, 0.8 + (k % 3) * 0.2, k % 2 ? C.plate : pick(rng, C.plateRim)));
    // mirror wall, built per solid wall segment so it never runs across a doorway (inset 0.2 m at doorway ends)
    const m0 = a.wall.minX + 0.8, m1 = a.wall.maxX - 0.8;
    for (const [s0, s1] of segs(sMaxZ)) {
      const u0 = Math.max(m0, s0 > sMaxZ.from + 1e-3 ? s0 + 0.2 : s0);
      const u1 = Math.min(m1, s1 < sMaxZ.to - 1e-3 ? s1 - 0.2 : s1);
      if (u1 - u0 < 1) continue;
      b.glow(0.12);
      sideBox(b, sMaxZ, u0, u1, -0.03, 0, 0.4, 2.3, 0xc3d4dc);
      b.glow(0);
      sideBox(b, sMaxZ, u0 - 0.05, u1 + 0.05, -0.035, 0, 2.3, 2.36, C.steel);
      const n = Math.max(1, Math.round((u1 - u0) / 1.7));
      for (let k = 0; k <= n; k++) { const u = u0 + (u1 - u0) * (k / n); sideBox(b, sMaxZ, u - 0.015, u + 0.015, -0.035, 0, 0.4, 2.3, C.steel); }
    }
    banner(b, sMinZ, a.wall.maxX - 2.2, 2.7, 1.5);
  } else if (a.index === 2) {
    // mat hall: wall pads, lockers, wooden dummies, weapon racks
    for (const s of ['minX', 'maxX', 'maxZ']) {
      const sd = side(a, s);
      for (const [u0, u1] of segs(sd)) for (let u = u0 + 0.6; u < u1 - 0.6; u += 1.0) sideBox(b, sd, u - 0.46, u + 0.46, -0.08, 0, 0.2, 1.9, C.pad);
    }
    slots(a, 'minX', 0.48, 0.35, 0.6, 0.6).forEach((p, k) => locker(B, p.x, p.z, p.yaw, k));
    slots(a, 'maxX', 1.9, 0.7, 0.6).forEach((p, k) => (k % 2 ? weaponRack(B, p.x, p.z, p.yaw) : woodenDummy(B, p.x, p.z, p.yaw)));
    for (const p of slots(a, 'maxZ', 2.3, 0.55, 0.6)) woodenDummy(B, p.x, p.z, p.yaw);
    for (const p of slots(a, 'minZ', 2.6, 0.45, 0.6)) bench(B, p.x, p.z, p.yaw + Math.PI / 2);
    banner(b, sMaxZ, a.center.x, 2.7, 1.8);
  } else {
    // the pit: bleachers, banners, Brick's corner (tire, sledgehammer), lotus emblem on the mat
    for (const s of ['minX', 'maxX']) {
      const sd = side(a, s);
      const p = { x: sd.line - sd.nx * 1.1, z: a.center.z };
      bleachers(B, p.x, p.z, Math.atan2(-sd.nx, 0) , a.wall.maxZ - a.wall.minZ - 3.2);
    }
    const tz = a.wall.maxZ - 1.0;
    b.cyl(a.wall.maxX - 1.6, 0, tz, 0.75, 0.32, 0x2a2b2d, { seg: 14 });
    b.cyl(a.wall.maxX - 1.6, 0.32, tz, 0.4, 0.01, 0x1f2022, { seg: 14 });
    b.bar(a.wall.minX + 2.0, 0.05, tz + 0.2, a.wall.minX + 2.3, 1.1, tz - 0.1, 0.03, C.wood, 6);
    b.box(a.wall.minX + 2.32, 1.1, tz - 0.12, 0.32, 0.16, 0.16, C.steel, 0.4);
    plateStack(b, a.wall.minX + 1.0, tz - 0.1, rng);
    plateStack(b, a.wall.minX + 1.5, tz + 0.2, rng);
    // lotus emblem on the mat (petals as flat polys)
    const cx = a.center.x, cz = a.center.z, y = 0.032;
    for (let i = 0; i < 8; i++) {
      const ang = i / 8 * Math.PI * 2;
      const tip = [cx + Math.sin(ang) * 2.1, y, cz + Math.cos(ang) * 2.1];
      const l = [cx + Math.sin(ang - 0.32) * 0.9, y, cz + Math.cos(ang - 0.32) * 0.9];
      const r = [cx + Math.sin(ang + 0.32) * 0.9, y, cz + Math.cos(ang + 0.32) * 0.9];
      b.poly([[cx, y, cz], l, tip, r], i % 2 ? C.white : 0xf0d9a0);
    }
    b.cyl(cx, 0.03, cz, 0.55, 0.004, C.gold, { seg: 16 });
    for (const s of ['minX', 'maxX']) { const sd = side(a, s); banner(b, sd, a.center.z - 3, 3.2, 2.2); banner(b, sd, a.center.z + 3, 3.2, 2.2); }
    banner(b, sMaxZ, a.center.x, 3.0, 2.6);
  }
}

// ------------------------------------------------------------------ lobby (start) + corridors

function lobby(B, a, ctx) {
  const { rng, lights } = ctx;
  const b = B.m, w = a.wall, H = a.ceil;
  b.floor(w.minX, w.minZ, w.maxX, w.maxZ, 0, 0.6, (ix, iz) => ((ix + iz) % 2 ? 0x9a948b : 0x8c867d), ao(a, 0.75));
  b.setAO(0.8, 1.5);
  for (const s of ['maxZ', 'minX', 'maxX']) wallSide(b, a, s, { h: H, color: C.concrete, doorH: DOOR_H, lintel: C.concrete, wainscot: 0x8a2f2a, wainscotH: 1.0 });
  b.noAO();
  // glass front on -Z with the street beyond
  const sd = side(a, 'minZ');
  sideBox(b, sd, w.minX - 0.3, w.maxX + 0.3, 0, 0.3, 0, 0.25, C.steel);
  sideBox(b, sd, w.minX - 0.3, w.maxX + 0.3, 0, 0.3, H - 0.5, H, C.concrete);
  for (let x = w.minX; x <= w.maxX + 0.01; x += (w.maxX - w.minX) / 4) sideBox(b, sd, x - 0.06, x + 0.06, 0, 0.25, 0.25, H - 0.5, C.steel);
  sideBox(B.gl, sd, w.minX, w.maxX, 0.12, 0.14, 0.25, H - 0.5, C.glassSky);
  b.glow(0.25);
  ceiling(b, { minX: w.minX - 0.3, maxX: w.maxX + 0.3, minZ: w.minZ - 0.3, maxZ: w.maxZ + 0.3 }, H, 0.3, C.ceiling);
  b.glow(1.3);
  for (let x = w.minX + 1.5; x < w.maxX - 1; x += 3) for (let z = w.minZ + 2; z < w.maxZ - 1; z += 2.5) {
    b.box(x, H - 0.04, z, 1.2, 0.04, 0.2, 0xfffaf0);
    lights.push({ x, y: H - 0.3, z, color: lin(0xfff4e0), intensity: 0.9, range: 5 });
  }
  b.glow(0);
  // reception desk + trophies + bench + plants
  L.set(w.maxX - 1.3, a.center.z + 0.6, -Math.PI / 2);
  L.box(b, 0, 0, 0, 2.6, 1.05, 0.6, 0x8a2f2a, { top: 0x2f3437 });
  L.box(b, 0, 1.05, -0.05, 2.7, 0.05, 0.75, 0x2f3437);
  L.box(b, 0.6, 1.1, 0.0, 0.4, 0.3, 0.05, 0x1f2326);
  const tz = w.maxZ - 0.3;
  b.boxMM(w.minX + 0.6, 1.2, tz - 0.3, w.minX + 3.2, 1.25, tz, C.woodDark);
  b.boxMM(w.minX + 0.6, 1.75, tz - 0.3, w.minX + 3.2, 1.8, tz, C.woodDark);
  for (let k = 0; k < 5; k++) {
    const x = w.minX + 0.9 + k * 0.5;
    b.cyl(x, 1.25, tz - 0.15, 0.06, 0.08, 0x2f3437, { seg: 6 });
    b.cyl(x, 1.33, tz - 0.15, 0.04, 0.2, C.gold, { rTop: 0.08, seg: 8 });
    b.cyl(x, 1.8, tz - 0.15, 0.05, 0.25, k % 2 ? C.gold : 0xc0c4c8, { rTop: 0.07, seg: 8 });
  }
  bench(B, w.minX + 0.6, a.center.z - 0.6, 0);
  plant(b, w.minX + 0.5, w.minZ + 0.6, 1.3, 0x2f3437, 0x4f8a55, rng);
  plant(b, w.maxX - 0.5, w.minZ + 0.6, 1.3, 0x2f3437, 0x4f8a55, rng);
  banner(b, side(a, 'maxZ'), a.corridorOut.x - 2.6, 1.6, 1.4);
}

function hall(B, c, ctx) {
  const b = B.m;
  b.setAO(0.78, 1.5);
  corridorShell(b, c, {
    h: c.ceil, wall: C.concrete, wainscot: 0x8a2f2a, wainscotH: 1.0, ceil: c.ceil, ceilColor: C.ceiling, ceilGlow: 0.25,
    floorFn: (ix, iz) => ((ix + iz) % 2 ? 0x9a948b : 0x8c867d), cell: c.w / 5,
  });
  b.noAO();
  b.glow(1.3);
  b.box(c.x, c.ceil - 0.04, (c.zA + c.zB) / 2, 0.25, 0.04, 1.2, 0xfffaf0);
  b.glow(0);
  ctx.lights.push({ x: c.x, y: c.ceil - 0.3, z: (c.zA + c.zB) / 2, color: lin(0xfff4e0), intensity: 0.8, range: 4 });
  // lockers along one side
  for (let z = c.zA + 0.4; z < c.zB - 0.3; z += 0.48) {
    if (c.len < 3) break;
    L.set(c.x - c.w / 2 + 0.26, z, Math.PI / 2);
    L.box(b, 0, 0, 0, 0.44, 1.85, 0.5, C.locker, { top: 0x6a8076 });
    L.box(b, 0.15, 0.95, 0.255, 0.03, 0.12, 0.02, C.chrome);
  }
}

function gateFrame(b, gate) {
  const hw = gate.w / 2;
  for (const s of [-1, 1]) b.boxMM(gate.x + s * hw - 0.08, 0, gate.z - 0.18, gate.x + s * hw + 0.08, DOOR_H + 0.08, gate.z + 0.18, C.steel);
  b.boxMM(gate.x - hw - 0.08, DOOR_H, gate.z - 0.18, gate.x + hw + 0.08, DOOR_H + 0.12, gate.z + 0.18, C.steel);
  // exit sign over the door
  const zs = gate.role === 'entry' ? 0.2 : -0.2;
  b.glow(1.5);
  b.box(gate.x, DOOR_H + 0.22, gate.z + zs, 0.5, 0.18, 0.04, 0x4fd18b);
  b.glow(0);
}

export function gate(g) {
  const leaves = [];
  const hw = g.w / 2;
  const away = g.role === 'entry' ? 1 : -1; // swing away from the room
  for (const s of [-1, 1]) {
    const lb = new MeshBuilder();
    const lw = hw - 0.02;
    const cx = -s * lw / 2;
    lb.box(cx, 0.02, 0, lw, DOOR_H - 0.04, 0.06, 0x5d7a8c);
    lb.box(cx, 0.02, 0, lw, 0.25, 0.065, 0x4c6575);
    lb.box(cx - s * 0.1, 1.55, 0.0, 0.32, 0.6, 0.07, 0x2c3a44);
    lb.box(cx + s * (lw / 2 - 0.15), 1.0, 0, 0.05, 0.05, 0.14, C.chrome);
    lb.box(cx, 1.02, 0, lw - 0.1, 0.04, 0.08, C.chrome);
    leaves.push({ builder: lb, anim: 'swing', dir: -s * away, amount: 1.55, pivot: [s * hw, 0, 0] });
  }
  return { leaves, openTime: 0.55, closeTime: 0.45 };
}

function exterior(B, layout, ctx) {
  const { rng } = ctx;
  const b = B.m, bd = layout.bounds;
  b.quad(bd.minX - 50, bd.minZ - 50, bd.maxX + 50, bd.maxZ + 50, -0.02, 0x9a9690);
  // street outside the lobby glass
  b.quad(bd.minX - 20, -16, bd.maxX + 20, -0.3, 0.0, 0x80858a);
  b.quad(bd.minX - 20, -2.6, bd.maxX + 20, -0.3, 0.05, 0xcfcac0);
  for (let i = 0; i < 6; i++) {
    const x = bd.minX - 14 + i * 7.5, h = 7 + rng() * 6;
    b.boxMM(x, 0, -24, x + 7.2, h, -16, pick(rng, [0xd8c3b0, 0xc9d3d8, 0xe0d6bf, 0xb9c4b0]));
    for (let y = 2.5; y < h - 1; y += 2.2) for (let k = 0; k < 3; k++) b.boxMM(x + 0.8 + k * 2.2, y, -16.02, x + 1.9 + k * 2.2, y + 1.2, -15.98, 0x6f8796);
  }
  // building mass around the gym (seen through skylights as the roofline): low parapets
  for (const a of layout.areas) {
    if (a.kind !== 'room') continue;
    const w = a.wall;
    b.boxMM(w.minX - 0.3, a.ceil + 0.35, w.minZ - 0.3, w.maxX + 0.3, a.ceil + 0.9, w.minZ, 0x9d9990);
  }
}

export function build(ctx) {
  const { layout } = ctx;
  for (const a of layout.areas) {
    const B = ctx.B(a);
    if (a.kind === 'start') lobby(B, a, ctx);
    else if (a.kind === 'corridor') hall(B, a, ctx);
    else { const sh = roomShell(B, a, ctx); dressRoom(B, a, ctx, sh); }
  }
  for (const g of layout.gates) gateFrame(ctx.B(g.corridor).m, g);
  exterior(ctx.ext, layout, ctx);
}

export default { id: 'gym', light, build, gate, bakeLift: 0.15 };
