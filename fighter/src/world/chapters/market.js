// Chapter 2: The Night Market. Warm lantern strings over wet stone, stalls under deep teal canopies, crates,
// a canal edge with lantern reflections. All light is baked into vertex glow: no fog, no glow pass.
import { MeshBuilder, mix, lin } from '../geo.js';
import { side, sideBox, spans, slots, ringSegments, inDoorway } from '../kit.js';
import { Local, crate, stool, sack, lanternString, lantern, plant } from '../props.js';

const C = {
  stoneA: 0x4a5258, stoneB: 0x414950, stoneC: 0x535b60, wet: 0x353d45, grout: 0x2e3439,
  facades: [0x5f6e6c, 0x7a5a4c, 0x6a6458, 0x56606e, 0x7c6a52, 0x5a5050, 0x4f6a66],
  trimDark: 0x2f2a27, wood: 0x7a5136, woodDark: 0x5a3a26, woodLight: 0x9b6a3f,
  canopy: [0x1f7a78, 0x2a8f86, 0x1b6b6e, 0x2f9d8f], canopyStripe: 0xe9e1cf,
  lanterns: [0xff7a2e, 0xf05a2a, 0xd8402c, 0xffa340, 0xff6a30],
  winLit: 0xffc77a, winDim: 0x3a3f4a, neonPink: 0xff6f9c, neonCyan: 0x5fe3e0, neonYellow: 0xffd56a,
  water: 0x10333b, canalWall: 0x5d5a52, rail: 0x2b2522, red: 0xb8322a, jade: 0x2f7f6a,
  goods: [0xe8553f, 0xf2a03d, 0x9bc35a, 0xf4d06f, 0xe9e1cf, 0xc0392b, 0x7fb069, 0xd98e5a],
};

export const light = {
  sunDir: [-0.42, 0.78, 0.42], sun: 0xa9bbff, sunI: 0.9,
  hemiSky: 0x5a6ea8, hemiGround: 0x7a5040, hemiI: 1.3, exposure: 1.15,
  sky: { top: 0x070d24, mid: 0x182350, horizon: 0x4b3f66, bottom: 0x161220, sun: 0xe6ecff, sunSize: 0.0009, halo: 0.35, midH: 0.28 },
};

const L = new Local();
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ------------------------------------------------------------------ pieces

/** Stone paver floor (gloss builder: wet sheen) over a rect, with AO near the edges. */
function paving(b, x0, z0, x1, z1, rng, edge = null) {
  b.floor(x0, z0, x1, z1, 0, 0.6, (ix, iz) => {
    const r = rng();
    const base = r < 0.33 ? C.stoneA : r < 0.66 ? C.stoneB : C.stoneC;
    return rng() < 0.18 ? mix(base, C.wet, 0.7) : base;
  }, edge);
}

/** A facade chunk along a side between u0..u1 (wall-local), height h. Shopfront at ground level. */
function facade(B, sd, u0, u1, h, rng, lights, opts = {}) {
  const b = B.m, t = 0.55;
  const col = opts.color ?? pick(rng, C.facades);
  sideBox(b, sd, u0, u1, 0, t, 0, h, col);
  // cornice + floor line
  sideBox(b, sd, u0, u1, -0.08, t, h - 0.25, h, mix(col, 0x000000, 0.35));
  sideBox(b, sd, u0, u1, -0.05, t, 3.0, 3.12, mix(col, 0x000000, 0.25));
  const wdt = u1 - u0;
  // ground floor: lit shopfront or shutter
  const shop = opts.shop ?? rng() < 0.65;
  if (wdt > 1.8) {
    const a = u0 + 0.35, c = u1 - 0.35;
    if (shop) {
      b.glow(0.45);
      sideBox(b, sd, a, c, 0.03, 0.06, 0.25, 2.55, 0xffa860);
      b.glow(0);
      // interior silhouettes: shelves + a mullion
      sideBox(b, sd, a, c, -0.01, 0.0, 1.35, 1.42, 0x4a3326);
      sideBox(b, sd, a, c, -0.01, 0.0, 0.25, 0.95, 0x5a3f2e);
      sideBox(b, sd, (a + c) / 2 - 0.04, (a + c) / 2 + 0.04, -0.01, 0.0, 0.95, 2.55, C.trimDark);
      sideBox(b, sd, a, c, -0.02, 0.0, 2.55, 2.65, C.trimDark);
      sideBox(b, sd, a - 0.06, a, -0.02, 0.05, 0, 2.65, C.trimDark);
      sideBox(b, sd, c, c + 0.06, -0.02, 0.05, 0, 2.65, C.trimDark);
      const m = (a + c) / 2, p = sd.axis === 'x' ? { x: m, z: sd.line - sd.nz * 0.6 } : { x: sd.line - sd.nx * 0.6, z: m };
      lights.push({ x: p.x, y: 1.4, z: p.z, color: lin(0xffb46a), intensity: 0.75, range: 3.4 });
    } else {
      for (let y = 0.0; y < 2.6; y += 0.12) sideBox(b, sd, a, c, -0.02, 0.0, y, y + 0.1, y % 0.24 < 0.12 ? 0x6b7275 : 0x5f6669);
      sideBox(b, sd, a, c, -0.04, 0.0, 2.6, 2.85, 0x4f5659);
    }
  }
  // upper floors: windows (some lit), AC units, a sign
  for (let y = 3.6; y < h - 1.2; y += 2.2) {
    const n = Math.max(1, Math.floor(wdt / 1.3));
    for (let i = 0; i < n; i++) {
      const u = u0 + wdt * ((i + 0.5) / n);
      const lit = rng() < 0.45;
      sideBox(b, sd, u - 0.42, u + 0.42, -0.05, 0, y - 0.06, y + 1.26, mix(col, 0x000000, 0.4));
      if (lit) b.glow(0.5);
      sideBox(b, sd, u - 0.36, u + 0.36, -0.06, -0.05, y, y + 1.2, lit ? pick(rng, [0xffae5c, 0xff9d4a, 0xffc070]) : C.winDim);
      b.glow(0);
      sideBox(b, sd, u - 0.025, u + 0.025, -0.07, -0.05, y, y + 1.2, mix(col, 0x000000, 0.4));
      sideBox(b, sd, u - 0.36, u + 0.36, -0.07, -0.05, y + 0.72, y + 0.77, mix(col, 0x000000, 0.4));
      if (rng() < 0.25) sideBox(b, sd, u - 0.3, u + 0.3, -0.5, -0.05, y - 0.05, y + 0.42, 0xd9d6cc);
      if (rng() < 0.2) { sideBox(b, sd, u - 0.55, u + 0.55, -0.7, -0.05, y - 0.12, y - 0.04, 0x3a3533); sideBox(b, sd, u - 0.55, u + 0.55, -0.7, -0.66, y - 0.04, y + 0.75, 0x3a3533); }
    }
  }
  if (rng() < 0.55 && wdt > 2) {
    const u = u0 + 0.5 + rng() * (wdt - 1.0), y0 = 3.3 + rng() * 1.5;
    const neon = pick(rng, [C.neonPink, C.neonCyan, C.neonYellow, 0xff8c42]);
    sideBox(b, sd, u - 0.25, u + 0.25, -0.6, -0.02, y0, y0 + 1.8, 0x1d1a1c);
    b.glow(1.4);
    sideBox(b, sd, u - 0.2, u + 0.2, -0.62, -0.6, y0 + 0.1, y0 + 1.7, neon);
    b.glow(0);
    const p = sd.axis === 'x' ? { x: u, z: sd.line - sd.nz * 0.9 } : { x: sd.line - sd.nx * 0.9, z: u };
    lights.push({ x: p.x, y: y0 + 0.9, z: p.z, color: lin(neon), intensity: 0.35, range: 3.0 });
  }
}

/** Facades along a whole side of a rect area, chunked, with lintels over openings (alley mouths). */
function facadeSide(B, a, s, rng, lights, hMin = 6.5, hMax = 9.5) {
  const sd = side(a, s);
  const ext = sd.axis === 'x' ? 0.55 : 0;
  for (const [u0, u1] of spans(sd.from - ext, sd.to + ext, sd.openings)) {
    let u = u0;
    while (u < u1 - 0.05) {
      const w = Math.min(u1 - u, 2.8 + rng() * 1.8);
      const last = u1 - (u + w) < 1.2;
      const ww = last ? u1 - u : w;
      facade(B, sd, u, u + ww, hMin + rng() * (hMax - hMin), rng, lights);
      u += ww;
    }
  }
  // archway lintels over alley mouths (beam with a sign)
  for (const [o0, o1] of sd.openings) {
    sideBox(B.m, sd, o0 - 0.1, o1 + 0.1, 0, 0.55, 3.4, 4.2, 0x4a3f3a);
    sideBox(B.m, sd, o0 + 0.3, o1 - 0.3, -0.06, 0, 3.55, 4.05, C.red);
    B.m.glow(0.8);
    sideBox(B.m, sd, o0 + 0.5, o1 - 0.5, -0.07, -0.06, 3.65, 3.95, 0xffd56a);
    B.m.glow(0);
  }
  return sd;
}

/** Market stall with a teal canopy, bulbs and goods. Local +Z faces the room. */
function stall(B, x, z, yaw, w, rng, lights, kind = 0) {
  const b = B.m;
  L.set(x, z, yaw);
  const cnp = pick(rng, C.canopy);
  // counter
  L.box(b, 0, 0, 0.1, w, 0.92, 0.7, C.wood, { top: C.woodLight });
  L.box(b, 0, 0.0, 0.46, w - 0.1, 0.12, 0.02, C.woodDark);
  // posts
  for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) { L.box(b, sx, 0, -0.3, 0.07, 2.55, 0.07, C.woodDark); L.box(b, sx, 0, 0.42, 0.06, 2.35, 0.06, C.woodDark); }
  // canopy (sloping toward the room) + stripes + valance
  L.box(b, 0, 2.42, -0.02, w + 0.25, 0.06, 1.0, cnp, { rx: 0.18 });
  for (let k = 0; k < 4; k++) L.box(b, -w / 2 + (k + 0.5) * (w / 4), 2.44, -0.02, 0.14, 0.065, 1.01, C.canopyStripe, { rx: 0.18 });
  L.box(b, 0, 2.22, 0.47, w + 0.25, 0.2, 0.03, cnp);
  // sign board on top
  L.box(b, 0, 2.55, -0.25, Math.min(1.4, w * 0.7), 0.4, 0.05, C.red);
  b.glow(0.9); L.box(b, 0, 2.62, -0.22, Math.min(1.2, w * 0.6), 0.26, 0.02, 0xffd56a); b.glow(0);
  // bulbs under the canopy
  b.glow(2.2);
  for (let k = 0; k < 3; k++) L.blob(b, -w / 2 + (k + 0.5) * (w / 3), 2.1, 0.2, 0.06, 0.07, 0.06, 0xffe0a0, 0);
  b.glow(0);
  lights.push({ x: L.px(0, 0.55), y: 1.9, z: L.pz(0, 0.55), color: lin(0xffc27a), intensity: 1.0, range: 3.4 });
  // goods
  if (kind === 0) {
    // bowls + pots (noodles)
    for (let k = 0; k < Math.floor(w / 0.35); k++) L.cyl(b, -w / 2 + 0.25 + k * 0.35, 0.92, 0.15 + (k % 2) * 0.15, 0.12, 0.07, k % 3 ? 0xe9e1cf : C.red, { rTop: 0.14, seg: 8 });
    L.cyl(b, w / 2 - 0.35, 0.92, -0.05, 0.22, 0.3, 0x8a8f93, { seg: 10 });
    L.cyl(b, w / 2 - 0.35, 1.22, -0.05, 0.23, 0.03, 0x6a6f73, { seg: 10 });
  } else if (kind === 1) {
    // fruit pyramids in crates
    for (let k = 0; k < Math.floor(w / 0.45); k++) {
      const cx = -w / 2 + 0.3 + k * 0.45, col = pick(rng, C.goods);
      L.box(b, cx, 0.92, 0.2, 0.4, 0.12, 0.5, C.woodLight);
      for (let j = 0; j < 4; j++) L.blob(b, cx + ((j % 2) - 0.5) * 0.18, 1.08 + (j > 1 ? 0.05 : 0), 0.2 + (j > 1 ? 0.1 : -0.1), 0.09, 0.08, 0.09, col);
    }
  } else {
    // hanging goods (lanterns for sale, ducks...)
    for (let k = 0; k < Math.floor(w / 0.4); k++) {
      const cx = -w / 2 + 0.3 + k * 0.4;
      L.box(b, cx, 0.92, 0.15, 0.3, 0.2 + rng() * 0.2, 0.3, pick(rng, C.goods));
      L.blob(b, cx, 1.75, 0.35, 0.09, 0.14, 0.09, rng() < 0.5 ? 0xb5562f : pick(rng, C.lanterns));
      L.box(b, cx, 1.88, 0.35, 0.01, 0.4, 0.01, C.rail);
    }
  }
}

function tables(b, x, z, rng) {
  b.cyl(x, 0, z, 0.06, 0.72, 0x3a3533, { seg: 6 });
  b.cyl(x, 0, z, 0.3, 0.03, 0x3a3533, { seg: 8 });
  b.cyl(x, 0.72, z, 0.45, 0.04, rng() < 0.5 ? 0xd9d2c3 : C.red, { seg: 12 });
  for (let i = 0; i < 3; i++) { const a = rng() * 6.28; stool(b, x + Math.cos(a) * 0.7, z + Math.sin(a) * 0.7, pick(rng, [C.red, 0x2f7f6a, 0xe0a33d]), 0x3a3533, 0.45); }
}

function lanternsAcross(B, a, ctx, n, y0 = 4.6, density = 0.85) {
  const { rng, lights } = ctx;
  const w = a.wall;
  for (let i = 0; i < n; i++) {
    let p0, p1;
    if (i % 2 === 0) { const z0 = w.minZ + 1 + rng() * (w.maxZ - w.minZ - 2), z1 = w.minZ + 1 + rng() * (w.maxZ - w.minZ - 2); p0 = [w.minX + 0.2, y0 + rng() * 0.8, z0]; p1 = [w.maxX - 0.2, y0 + rng() * 0.8, z1]; }
    else { const x0 = w.minX + 1 + rng() * (w.maxX - w.minX - 2), x1 = w.minX + 1 + rng() * (w.maxX - w.minX - 2); p0 = [x0, y0 + rng() * 0.8, w.minZ + 0.2]; p1 = [x1, y0 + rng() * 0.8, w.maxZ - 0.2]; }
    const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
    lanternString(B.nc, p0, p1, Math.floor(len * density), 0.7, C.lanterns, lights, { every: 2, intensity: 0.75, range: 6.5, r: 0.15, glow: 0.85 });
  }
}

// ------------------------------------------------------------------ areas

function edgeAO(a) {
  const w = a.wall;
  return (x, z) => { const d = Math.min(x - w.minX, w.maxX - x, z - w.minZ, w.maxZ - z); return 0.72 + 0.28 * smooth(0, 1.2, d); };
}

function canal(B, ctx, x0, x1, z0, z1, lightsAt) {
  // water surface below the bank + bank wall + reflections of lanterns (glowing streaks)
  const { rng } = ctx;
  B.g.quad(x0, z0, x1, z1, -0.95, C.water);
  B.m.boxMM(x1 - 0.4, -1.2, z0, x1, 0.02, z1, C.canalWall);
  B.m.boxMM(x1 - 0.45, 0.0, z0, x1 + 0.05, 0.12, z1, 0x6e6a60);
  // railing
  for (let z = z0 + 0.2; z < z1; z += 1.3) B.m.box(x1 - 0.2, 0.12, z, 0.08, 0.9, 0.08, C.rail);
  B.m.boxMM(x1 - 0.25, 1.0, z0, x1 - 0.15, 1.06, z1, C.rail);
  B.m.boxMM(x1 - 0.23, 0.55, z0, x1 - 0.17, 0.58, z1, C.rail);
  // far bank facades
  const sd = { s: 'far', axis: 'z', line: x0, from: z0, to: z1, nx: -1, nz: 0, openings: [] };
  let z = z0;
  while (z < z1 - 0.5) { const w = Math.min(z1 - z, 3 + rng() * 2); facade(B, sd, z, z + w, 6 + rng() * 4, rng, ctx.lights); z += w; }
  // lantern reflections: soft warm streaks on the water
  B.g.glow(0.9);
  for (const p of lightsAt) {
    const len = 1.2 + rng() * 1.5;
    for (let k = 0; k < 3; k++) B.g.quad(p.x - len / 2, p.z - 0.05 + k * 0.14 - 0.14, p.x + len / 2, p.z + 0.04 + k * 0.14 - 0.14, -0.94, mix(C.water, 0xff9b4a, 0.55 - k * 0.12));
  }
  B.g.glow(0);
  // a moored boat
  const bz = (z0 + z1) / 2, bx = (x0 + x1) / 2 + 0.6;
  L.set(bx, bz, 0);
  L.box(B.m, 0, -1.05, 0, 1.3, 0.45, 3.6, 0x6b4a32, { top: 0x7c5a3c });
  L.box(B.m, 0, -0.62, 0, 1.15, 0.05, 3.3, 0x8a6a48);
  L.box(B.m, 0, -0.6, 0.6, 1.1, 0.7, 1.2, 0x2f7f6a, { top: 0x27675a });
  lantern(B.nc, bx, 0.4, bz + 1.4, 0.13, 0xff9b4a, 1.1);
  ctx.lights.push({ x: bx, y: 0.2, z: bz + 1.4, color: lin(0xff9b4a), intensity: 0.5, range: 2.5 });
}

function room(B, a, ctx) {
  const { rng, lights } = ctx;
  const w = a.wall;
  paving(B.g, w.minX - 0.6, w.minZ - 0.6, w.maxX + 0.6, w.maxZ + 0.6, rng, edgeAO(a));
  // facades on three/four sides
  const sides = a.canal ? ['minZ', 'maxZ', 'maxX'] : ['minZ', 'maxZ', 'minX', 'maxX'];
  for (const s of sides) facadeSide(B, a, s, rng, lights);
  // stalls along the long sides, crates in the corners
  const kinds = [0, 1, 2];
  for (const s of a.canal ? ['maxX'] : ['minX', 'maxX']) {
    for (const p of slots(a, s, 2.3, 0.75, 0.6, 0.3)) stall(B, p.x, p.z, p.yaw, 2.0, rng, lights, kinds[(a.index + Math.floor(rng() * 3)) % 3]);
  }
  for (const s of ['minZ', 'maxZ']) {
    const ps = slots(a, s, 1.0, 0.55, 0.7);
    ps.forEach((p, k) => {
      if (k % 4 === 0) { crate(B.m, p.x, 0, p.z, 0.6, C.woodLight, rng()); crate(B.m, p.x + 0.05, 0.48, p.z, 0.5, 0x8a5c36, rng()); }
      else if (k % 4 === 1) sack(B.m, p.x, p.z, 1.0, pick(rng, [0xcdb58a, 0xb89a6a, 0xd8c7a0]), rng);
      else if (k % 4 === 2) { B.m.cyl(p.x, 0, p.z, 0.25, 0.75, pick(rng, [0x2f7f6a, C.red, 0x4a5a6a]), { seg: 10 }); }
      else plant(B.m, p.x, p.z, 1.1, 0x8a5c36, 0x4f7f4a, rng);
    });
  }
  if (a.canal) {
    const x1 = w.minX;
    const refl = [];
    for (let z = w.minZ + 1; z < w.maxZ - 1; z += 2.2) refl.push({ x: x1 - 2.5 - rng() * 4, z });
    canal(B, ctx, x1 - 9, x1, w.minZ - 0.6, w.maxZ + 0.6, refl);
    // tables along the canal railing
    for (const p of slots(a, 'minX', 2.6, 0.9, 0.6)) tables(B.m, p.x, p.z, rng);
    // lantern string along the canal railing
    lanternString(B.nc, [x1 - 0.2, 3.2, w.minZ + 0.3], [x1 - 0.2, 3.2, w.maxZ - 0.3], 12, 0.25, C.lanterns, lights, { every: 2, intensity: 0.7, range: 5, glow: 0.85 });
    for (let z = w.minZ + 0.3; z < w.maxZ; z += (w.maxZ - w.minZ - 0.6) / 3) B.m.box(x1 - 0.2, 0, z, 0.1, 3.3, 0.1, C.rail);
  }
  lanternsAcross(B, a, ctx, a.index === 2 ? 7 : 5, 4.4);
  if (a.index === 2) {
    // big hanging lantern cluster over the court
    for (let i = 0; i < 7; i++) {
      const ang = i / 7 * Math.PI * 2;
      const x = a.center.x + Math.cos(ang) * 1.6, z = a.center.z + Math.sin(ang) * 1.6;
      lantern(B.nc, x, 5.3 + (i % 2) * 0.4, z, 0.32, C.lanterns[i % C.lanterns.length], 1.0);
      B.nc.beam(x, 5.3 + (i % 2) * 0.4 + 0.32, z, a.center.x, 7.6, a.center.z, 0.02, 0.02, C.rail);
      lights.push({ x, y: 5.0, z, color: lin(C.lanterns[i % C.lanterns.length]), intensity: 0.7, range: 7 });
    }
    lantern(B.nc, a.center.x, 5.9, a.center.z, 0.55, 0xffb35c, 1.0);
  }
}

function bossRoom(B, a, ctx) {
  const { rng, lights } = ctx;
  const { cx, cz, rWall, rFloor } = a.disc;
  // round floor: concentric paving rings + a central inlaid medallion
  const g = B.g;
  const rings = 14, segs = 40;
  for (let i = 0; i < rings; i++) {
    const r0 = (i / rings) * (rWall + 0.6), r1 = ((i + 1) / rings) * (rWall + 0.6);
    for (let j = 0; j < segs; j++) {
      const a0 = j / segs * Math.PI * 2, a1 = (j + 1) / segs * Math.PI * 2;
      let col = (i + j) % 2 ? C.stoneA : C.stoneB;
      if (rng() < 0.15) col = mix(col, C.wet, 0.7);
      if (i === 5) col = 0x6b5a4a;
      if (i < 2) col = (j % 2) ? C.red : 0x8a2a24;
      const ao = 0.72 + 0.28 * smooth(rFloor + 1.2, rFloor - 0.3, r1);
      g.poly([[cx + Math.sin(a0) * r0, 0, cz + Math.cos(a0) * r0], [cx + Math.sin(a0) * r1, 0, cz + Math.cos(a0) * r1], [cx + Math.sin(a1) * r1, 0, cz + Math.cos(a1) * r1], [cx + Math.sin(a1) * r0, 0, cz + Math.cos(a1) * r0]], mix(col, 0x000000, 1 - ao));
    }
  }
  // ring of facades with stalls in front
  const segN = 14;
  ringSegments(a, segN, 0.2, (x, z, ang, segW, i) => {
    L.set(x, z, ang + Math.PI);
    const h = 6.5 + rng() * 3;
    const col = pick(rng, C.facades);
    L.box(B.m, 0, 0, -0.3, segW + 0.35, h, 0.6, col);
    L.box(B.m, 0, h - 0.25, -0.35, segW + 0.45, 0.25, 0.75, mix(col, 0x000000, 0.35));
    const lit = rng() < 0.6;
    if (lit) {
      B.m.glow(0.45); L.box(B.m, 0, 0.25, 0.01, segW - 0.7, 2.3, 0.02, 0xffa860); B.m.glow(0);
      L.box(B.m, 0, 1.35, 0.025, segW - 0.7, 0.07, 0.02, 0x4a3326);
      lights.push({ x: L.px(0, 0.7), y: 1.4, z: L.pz(0, 0.7), color: lin(0xffb46a), intensity: 0.7, range: 3.4 });
    }
    for (let y = 3.6; y < h - 1.2; y += 2.2) for (const u of [-0.8, 0.8]) {
      const on = rng() < 0.5;
      if (on) B.m.glow(0.5);
      L.box(B.m, u, y, 0.01, 0.7, 1.2, 0.03, on ? 0xffae5c : C.winDim);
      B.m.glow(0);
      L.box(B.m, u, y, 0.03, 0.05, 1.2, 0.02, mix(col, 0x000000, 0.4));
      L.box(B.m, u, y + 0.72, 0.03, 0.7, 0.05, 0.02, mix(col, 0x000000, 0.4));
    }
    if (i % 2 === 0) stall(B, L.px(0, 0.95), L.pz(0, 0.95), ang + Math.PI, Math.min(2.2, segW - 0.4), rng, lights, i % 3);
    else { crate(B.m, L.px(-0.6, 0.7), 0, L.pz(-0.6, 0.7), 0.55, C.woodLight, rng()); tables(B.m, L.px(0.5, 1.0), L.pz(0.5, 1.0), rng); }
  });
  // Madame Shu's giant wok station at the back
  const bx = cx, bz = cz + rWall - 1.0;
  L.set(bx, bz, Math.PI);
  L.box(B.m, 0, 0, 0, 2.6, 0.95, 0.9, 0x6a6f73, { top: 0x5a5f63 });
  L.cyl(B.m, -0.6, 0.95, 0.1, 0.55, 0.28, 0x2a2d2f, { rTop: 0.62, seg: 14 });
  L.cyl(B.m, 0.6, 0.95, 0.1, 0.42, 0.22, 0x2a2d2f, { rTop: 0.48, seg: 14 });
  B.m.glow(1.1); L.box(B.m, 0, 0.1, 0.46, 2.2, 0.25, 0.02, 0xff7a3a); B.m.glow(0);
  lights.push({ x: L.px(0, 0.8), y: 0.6, z: L.pz(0, 0.8), color: lin(0xff7a3a), intensity: 1.2, range: 3.5 });
  // woven chords of lantern strings over the arena + one big lantern in the middle
  for (let i = 0; i < 7; i++) {
    const a0 = i / 7 * Math.PI * 2 + 0.2, a1 = a0 + Math.PI * 0.72;
    const r = rWall - 0.2;
    lanternString(B.nc, [cx + Math.sin(a0) * r, 5.4, cz + Math.cos(a0) * r], [cx + Math.sin(a1) * r, 5.4, cz + Math.cos(a1) * r],
      13, 1.0, C.lanterns, lights, { every: 3, intensity: 0.7, range: 6.5, r: 0.15, glow: 0.85 });
  }
  lantern(B.nc, cx, 5.0, cz, 0.5, 0xff9b4a, 1.0);
  B.nc.beam(cx, 5.5, cz, cx, 9, cz, 0.02, 0.02, C.rail);
  lights.push({ x: cx, y: 4.6, z: cz, color: lin(0xffa860), intensity: 1.2, range: 8 });
}

function startArea(B, a, ctx) {
  const { rng, lights } = ctx;
  const w = a.wall;
  paving(B.g, w.minX - 0.6, w.minZ - 0.6, w.maxX + 0.6, w.maxZ + 0.6, rng, edgeAO(a));
  facadeSide(B, a, 'maxX', rng, lights, 6, 8);
  facadeSide(B, a, 'maxZ', rng, lights, 7, 9);
  // canal along -X
  const refl = [];
  for (let z = w.minZ + 1; z < w.maxZ; z += 2.5) refl.push({ x: w.minX - 2.5 - rng() * 3, z });
  canal(B, ctx, w.minX - 9, w.minX, w.minZ - 8, w.maxZ + 0.6, refl);
  // paifang arch at the start
  const z0 = w.minZ + 0.4, x0 = a.center.x;
  for (const s of [-1, 1]) { B.m.cyl(x0 + s * 2.6, 0, z0, 0.16, 4.2, C.red, { seg: 8 }); B.m.cyl(x0 + s * 2.6, 0, z0, 0.26, 0.4, 0x3a3533, { seg: 8 }); }
  B.m.box(x0, 3.7, z0, 6.0, 0.35, 0.4, C.red);
  B.m.box(x0, 4.05, z0, 6.6, 0.12, 0.9, C.jade);
  B.m.box(x0, 4.17, z0, 5.8, 0.3, 0.7, 0x27675a);
  B.m.glow(1.0); B.m.box(x0, 3.25, z0, 2.0, 0.42, 0.06, 0xffd56a); B.m.glow(0);
  lantern(B.nc, x0 - 1.6, 3.2, z0, 0.22, 0xff8c42, 1.1); lantern(B.nc, x0 + 1.6, 3.2, z0, 0.22, 0xff8c42, 1.1);
  lights.push({ x: x0, y: 3, z: z0 + 0.6, color: lin(0xffa860), intensity: 1.0, range: 5 });
  // closed street beyond (-Z): a barrier + cart
  B.m.boxMM(w.minX, 0, w.minZ - 0.6, w.maxX + 0.6, 1.0, w.minZ - 0.3, 0x56606e);
  for (const p of slots(a, 'maxX', 2.6, 0.75, 0.6, 0.3)) stall(B, p.x, p.z, p.yaw, 1.8, rng, lights, 1);
  lanternString(B.nc, [w.minX + 0.2, 3.4, w.minZ + 1], [w.minX + 0.2, 3.4, w.maxZ - 0.3], 10, 0.25, C.lanterns, lights, { every: 2, intensity: 0.7, range: 5, glow: 0.85 });
  lanternsAcross(B, a, ctx, 3, 4.2);
}

function alleyway(B, c, ctx) {
  const { rng, lights } = ctx;
  const x0 = c.x - c.w / 2, x1 = c.x + c.w / 2;
  paving(B.g, x0, c.zA, x1, c.zB, rng);
  // side facades (tall, close)
  for (const [x, nx] of [[x0, -1], [x1, 1]]) {
    const sd = { s: 'c', axis: 'z', line: x, from: c.zA, to: c.zB, nx, nz: 0, openings: [] };
    let z = c.zA;
    while (z < c.zB - 0.1) { const w = Math.min(c.zB - z, 2.5 + rng() * 1.5); facade(B, sd, z, z + w, 7 + rng() * 3, rng, lights, { shop: rng() < 0.4 }); z += w; }
  }
  // hanging signs + lanterns
  for (let z = c.zA + 0.8; z < c.zB - 0.5; z += 1.6) {
    lanternString(B.nc, [x0, 3.6 + rng() * 0.6, z], [x1, 3.6 + rng() * 0.6, z + (rng() - 0.5)], 3, 0.3, C.lanterns, lights, { every: 1, intensity: 0.6, range: 4.5, r: 0.13, glow: 0.85 });
  }
  const sz = (c.zA + c.zB) / 2;
  B.m.box(x0 + 0.35, 3.0, sz, 0.08, 1.6, 0.5, C.red);
  B.m.glow(1.3); B.m.box(x0 + 0.4, 3.15, sz, 0.02, 1.3, 0.36, pick(rng, [C.neonYellow, C.neonCyan])); B.m.glow(0);
}

// ------------------------------------------------------------------ gates + exterior

function gateFrame(b, gate) {
  const hw = gate.w / 2;
  for (const s of [-1, 1]) b.boxMM(gate.x + s * hw - 0.12, 0, gate.z - 0.3, gate.x + s * hw + 0.12, 3.0, gate.z + 0.3, 0x3a2a22);
  b.boxMM(gate.x - hw - 0.25, 2.9, gate.z - 0.32, gate.x + hw + 0.25, 3.2, gate.z + 0.32, C.red);
  b.boxMM(gate.x - hw - 0.4, 3.2, gate.z - 0.45, gate.x + hw + 0.4, 3.32, gate.z + 0.45, C.jade);
}

export function gate(g) {
  const leaves = [];
  const hw = g.w / 2;
  const zo = g.role === 'entry' ? -0.27 : 0.27;
  for (const s of [-1, 1]) {
    const lb = new MeshBuilder();
    const lw = hw + 0.06;
    const cx = -s * lw / 2; // leaf built so its outer edge is at the pivot side
    lb.box(cx, 0.05, 0, lw, 2.82, 0.08, 0x5a2a22);
    lb.glow(0.55);
    for (let r = 0; r < 4; r++) for (let q = 0; q < 2; q++) lb.box(cx - lw / 2 + 0.12 + (lw - 0.24) * (q + 0.5) / 2, 0.25 + r * 0.62, 0.0, (lw - 0.36) / 2, 0.5, 0.1, 0xf3d9a6);
    lb.glow(0);
    for (let r = 0; r <= 4; r++) lb.box(cx, 0.18 + r * 0.62, 0, lw, 0.06, 0.11, 0x3a1d18);
    lb.box(cx, 0.05, 0, 0.06, 2.82, 0.11, 0x3a1d18);
    leaves.push({ builder: lb, anim: 'slide', dir: s, amount: lw + 0.05, pivot: [s * lw, 0, zo] });
  }
  return { leaves, openTime: 0.7, closeTime: 0.5 };
}

function exterior(B, layout, ctx) {
  const { rng } = ctx;
  const b = B.m;
  const bd = layout.bounds;
  b.quad(bd.minX - 60, bd.minZ - 60, bd.maxX + 60, bd.maxZ + 60, -1.3, 0x14181c);
  // distant towers with sparse lit windows
  for (let i = 0; i < 46; i++) {
    const ang = rng() * Math.PI * 2, r = 45 + rng() * 60;
    const x = (bd.minX + bd.maxX) / 2 + Math.sin(ang) * r, z = (bd.minZ + bd.maxZ) / 2 + Math.cos(ang) * r * 1.2;
    const w = 6 + rng() * 10, h = 14 + rng() * 30;
    const col = mix(0x1a2142, 0x2a2c48, rng());
    b.box(x, -1, z, w, h, w * (0.7 + rng() * 0.6), col, rng() * 3);
    b.glow(1.2);
    const n = Math.floor(rng() * 6);
    for (let k = 0; k < n; k++) b.box(x + (rng() - 0.5) * w * 0.6, 4 + rng() * (h - 6), z + (rng() - 0.5) * w * 0.6, 0.8, 0.6, 0.8, pick(rng, [C.winLit, 0xffe3b0, C.neonPink]));
    b.glow(0);
  }
}

export function build(ctx) {
  const { layout } = ctx;
  for (const a of layout.areas) {
    const B = ctx.B(a);
    if (a.kind === 'start') startArea(B, a, ctx);
    else if (a.kind === 'corridor') alleyway(B, a, ctx);
    else if (a.shape === 'disc') bossRoom(B, a, ctx);
    else room(B, a, ctx);
  }
  for (const g of layout.gates) gateFrame(ctx.B(g.corridor).m, g);
  exterior(ctx.ext, layout, ctx);
}

export default { id: 'market', light, build, gate, bakeLift: 0.25 };
