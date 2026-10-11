// Chapter 4: Abacus Tower. A rooftop garden at golden hour: pale stone terraces on linked tower tops, glass
// railings, maple trees, flat reflecting pools, stone lanterns and a distant skyline in warm haze (by colour only).
import { MeshBuilder, mix, lin } from '../geo.js';
import { side, sideBox, spans, slots, ringSegments, inDoorway } from '../kit.js';
import { Local, plant } from '../props.js';

const C = {
  paveA: 0xeee6d8, paveB: 0xe4dac8, paveC: 0xf3ece0, border: 0xc9bca6, parapet: 0xd9cfbd, coping: 0xf0e9dc,
  brass: 0xc99a4a, gold: 0xe0b552, glass: 0xd8eef2, water: 0x7fb3c8, waterDeep: 0x5f97b0, rim: 0xd2c6b0,
  trunk: 0x5b4636, maple: [0xd2553a, 0xe0773c, 0xc23b2e, 0xe89a46, 0xb8402f], hedge: 0x5f7f4f, hedgeB: 0x6e8f58,
  lanternStone: 0xbdb3a2, gravel: 0xd8d3c8, rake: 0xc8c2b6, rock: 0x8f8a82, bamboo: 0x7fa65a,
  facade: 0xd9cfc0, facadeWin: 0x8fa9bf, facadeDark: 0xb8ad9c, white: 0xf6f2ea, wood: 0x8a5c3a,
  sky: [0x8fa4c2, 0x9aaecb, 0xa9b6cc, 0xb9bfd0, 0xc9c3c8, 0xd6c6bd],
};

export const light = {
  sunDir: [-0.74, 0.27, 0.62], sun: 0xffc887, sunI: 3.7,
  hemiSky: 0xa8c8e8, hemiGround: 0xd2a77c, hemiI: 1.2, exposure: 1.0,
  sky: { top: 0x4a7fc0, mid: 0x9cc0de, horizon: 0xffd6a0, bottom: 0xe2b98e, sun: 0xffe2a8, sunSize: 0.0026, halo: 1.5, midH: 0.22 },
};

const L = new Local();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ props

function maple(b, x, z, s, rng, planter = true) {
  if (planter) {
    b.box(x, 0, z, 1.1 * s, 0.5, 1.1 * s, C.parapet, 0, { top: C.coping });
    b.box(x, 0.5, z, 0.95 * s, 0.02, 0.95 * s, 0x6a5240);
  }
  const h = 2.0 * s, y0 = planter ? 0.5 : 0;
  b.cyl(x, y0, z, 0.09 * s, h, C.trunk, { rTop: 0.06 * s, seg: 6 });
  b.bar(x, y0 + h * 0.6, z, x + 0.5 * s, y0 + h * 1.0, z + 0.2 * s, 0.04 * s, C.trunk, 5);
  b.bar(x, y0 + h * 0.55, z, x - 0.45 * s, y0 + h * 0.95, z - 0.25 * s, 0.04 * s, C.trunk, 5);
  for (let i = 0; i < 7; i++) {
    const a = rng() * 6.28, r = (0.2 + rng() * 0.7) * s;
    b.blob(x + Math.cos(a) * r, y0 + h + (rng() * 0.7 - 0.1) * s, z + Math.sin(a) * r, (0.45 + rng() * 0.3) * s, (0.35 + rng() * 0.2) * s, (0.45 + rng() * 0.3) * s, pick(rng, C.maple), 0, rng() * 3);
  }
}

function stoneLantern(b, x, z, lights) {
  b.box(x, 0, z, 0.5, 0.12, 0.5, C.lanternStone);
  b.cyl(x, 0.12, z, 0.09, 0.75, C.lanternStone, { seg: 6 });
  b.box(x, 0.87, z, 0.42, 0.08, 0.42, C.lanternStone);
  b.glow(1.4);
  b.box(x, 0.95, z, 0.28, 0.26, 0.28, 0xffe0a0);
  b.glow(0);
  b.cyl(x, 1.21, z, 0.36, 0.16, C.lanternStone, { rTop: 0.05, seg: 6 });
  lights.push({ x, y: 1.0, z, color: lin(0xffd08a), intensity: 0.35, range: 2.2 });
}

function bench(B, x, z, yaw) {
  L.set(x, z, yaw);
  L.box(B.m, 0, 0.42, 0, 1.6, 0.07, 0.45, C.wood, { top: 0x9c6a44 });
  for (const s of [-0.65, 0.65]) L.box(B.m, s, 0, 0, 0.14, 0.42, 0.42, C.parapet);
}

function pool(B, x0, z0, x1, z1, rng, lilies = true) {
  B.m.boxMM(x0 - 0.18, 0, z0 - 0.18, x1 + 0.18, 0.16, z0, C.rim);
  B.m.boxMM(x0 - 0.18, 0, z1, x1 + 0.18, 0.16, z1 + 0.18, C.rim);
  B.m.boxMM(x0 - 0.18, 0, z0, x0, 0.16, z1, C.rim);
  B.m.boxMM(x1, 0, z0, x1 + 0.18, 0.16, z1, C.rim);
  B.g.floor(x0, z0, x1, z1, 0.1, 0.5, () => C.water, (x, z) => 0.8 + 0.2 * smooth(0, 0.6, Math.min(x - x0, x1 - x, z - z0, z1 - z)));
  if (lilies) {
    const n = Math.floor((x1 - x0) * (z1 - z0) * 0.6);
    for (let i = 0; i < n; i++) {
      const x = x0 + 0.2 + rng() * (x1 - x0 - 0.4), z = z0 + 0.2 + rng() * (z1 - z0 - 0.4);
      B.m.cyl(x, 0.1, z, 0.12 + rng() * 0.1, 0.012, rng() < 0.85 ? 0x6f9a55 : 0xf2b8c6, { seg: 7 });
    }
  }
}

function hedge(b, x0, z0, x1, z1, h = 0.65) {
  b.boxMM(x0, 0, z0, x1, h, z1, C.hedge, { top: C.hedgeB });
}

function bamboo(b, x, z, rng) {
  for (let i = 0; i < 7; i++) {
    const px = x + (rng() - 0.5) * 0.6, pz = z + (rng() - 0.5) * 0.6, h = 2.6 + rng() * 1.6;
    b.cyl(px, 0, pz, 0.035, h, C.bamboo, { seg: 5 });
    b.blob(px + (rng() - 0.5) * 0.3, h - 0.1, pz + (rng() - 0.5) * 0.3, 0.3, 0.45, 0.3, mix(0x7fa65a, 0x4f7a3a, rng()), 0);
  }
}

// ------------------------------------------------------------------ shells

/** Pale stone pavers over a rect with a darker border on the floor edge. */
function paving(b, a, x0, z0, x1, z1) {
  const f = a ? a.floor : null;
  b.floor(x0, z0, x1, z1, 0, 0.8, (ix, iz, x, z) => {
    if (f && (Math.abs(x - f.minX) < 0.4 || Math.abs(x - f.maxX) < 0.4 || Math.abs(z - f.minZ) < 0.4 || Math.abs(z - f.maxZ) < 0.4)
      && x > f.minX - 0.4 && x < f.maxX + 0.4 && z > f.minZ - 0.4 && z < f.maxZ + 0.4) return C.border;
    const r = (ix * 13 + iz * 7) % 5;
    return r === 0 ? C.paveB : r === 1 ? C.paveC : C.paveA;
  }, a ? (x, z) => { const w = a.wall; const d = Math.min(x - w.minX, w.maxX - x, z - w.minZ, w.maxZ - z); return 0.85 + 0.15 * smooth(0, 0.8, d); } : null);
}

/** Parapet + glass railing along a side (gaps at openings). */
function railingSide(B, a, s) {
  const sd = side(a, s);
  const ext = sd.axis === 'x' ? 0.35 : 0;
  for (const [u0, u1] of spans(sd.from - ext, sd.to + ext, sd.openings)) railRun(B, sd, u0, u1);
  return sd;
}
function railRun(B, sd, u0, u1) {
  sideBox(B.m, sd, u0, u1, 0, 0.35, 0, 0.42, C.parapet);
  sideBox(B.m, sd, u0, u1, -0.04, 0.39, 0.42, 0.48, C.coping);
  sideBox(B.gl, sd, u0, u1, 0.15, 0.17, 0.48, 1.45, C.glass);
  sideBox(B.m, sd, u0, u1, 0.11, 0.21, 1.42, 1.48, C.brass);
  for (let u = u0 + 0.05; u < u1; u += 1.6) sideBox(B.m, sd, u, Math.min(u1, u + 0.05), 0.13, 0.19, 0.48, 1.42, C.brass);
  // tower edge + facade going down (seen over the railing)
  sideBox(B.m, sd, u0, u1, 0.35, 0.9, -0.25, 0.02, C.coping);
}

function towerBody(b, rect, rng, top = 0) {
  // facade below the terrace: stone with horizontal window bands, down into the haze
  const { minX, maxX, minZ, maxZ } = rect;
  b.boxMM(minX, -70, minZ, maxX, top - 0.25, maxZ, C.facade, { bottom: true });
  for (let y = -2.2; y > -60; y -= 3.4) {
    b.boxMM(minX - 0.02, y - 1.6, minZ - 0.02, maxX + 0.02, y, maxZ + 0.02, mix(C.facadeWin, 0xffd6a0, 0.15));
    b.boxMM(minX - 0.06, y + 0.25, minZ - 0.06, maxX + 0.06, y + 0.4, maxZ + 0.06, C.white);
  }
}

function terrace(B, a, ctx) {
  const { rng, lights } = ctx;
  const w = a.wall, b = B.m;
  paving(b, a, w.minX - 0.9, w.minZ - 0.9, w.maxX + 0.9, w.maxZ + 0.9);
  for (const s of ['minZ', 'maxZ', 'minX', 'maxX']) railingSide(B, a, s);
  towerBody(b, { minX: w.minX - 0.9, maxX: w.maxX + 0.9, minZ: w.minZ - 0.9, maxZ: w.maxZ + 0.9 }, rng);
  const sMinX = side(a, 'minX'), sMaxX = side(a, 'maxX');
  if (a.index === 0) {
    // maples in planters + lanterns + benches, a scatter of fallen leaves
    for (const s of ['minX', 'maxX']) slots(a, s, 3.0, 0.95, 0.6).forEach((p, k) => (k % 2 ? stoneLantern(b, p.x, p.z, lights) : maple(b, p.x, p.z, 1.0 + rng() * 0.25, rng)));
    for (const s of ['minZ', 'maxZ']) slots(a, s, 2.4, 0.8, 0.8).forEach((p, k) => (k % 2 ? bench(B, p.x, p.z, p.yaw) : plant(b, p.x, p.z, 1.3, C.parapet, 0x6e8f58, rng)));
    leaves(b, a, rng, 70);
  } else if (a.index === 1) {
    // pool garden: long reflecting pools in the side bands, lilies, maples at the corners
    for (const sd of [sMinX, sMaxX]) {
      const xin = sd.line - sd.nx * 0.45, xout = sd.line - sd.nx * 1.55;
      pool(B, Math.min(xin, xout), w.minZ + 2.0, Math.max(xin, xout), w.maxZ - 2.0, rng);
    }
    for (const [x, z] of [[w.minX + 1.0, w.minZ + 1.0], [w.maxX - 1.0, w.minZ + 1.0], [w.minX + 1.0, w.maxZ - 1.0], [w.maxX - 1.0, w.maxZ - 1.0]]) {
      if (!inDoorway(a, x, z, 0.4)) maple(b, x, z, 1.15, rng);
    }
    for (const s of ['minZ', 'maxZ']) slots(a, s, 2.0, 0.9, 0.8, 1.2).forEach((p) => stoneLantern(b, p.x, p.z, lights));
    leaves(b, a, rng, 30);
  } else if (a.index === 2) {
    // stone walk: raked gravel beds with rocks, bamboo, hedges
    for (const sd of [sMinX, sMaxX]) {
      const xin = sd.line - sd.nx * 0.3, xout = sd.line - sd.nx * 1.5;
      const x0 = Math.min(xin, xout), x1 = Math.max(xin, xout);
      b.floor(x0, w.minZ + 1.2, x1, w.maxZ - 1.2, 0.02, 0.3, (ix, iz) => (iz % 2 ? C.gravel : C.rake));
      for (let k = 0; k < 3; k++) b.blob((x0 + x1) / 2 + (rng() - 0.5) * 0.5, 0.15, w.minZ + 2.5 + k * 3.5 + rng(), 0.35 + rng() * 0.25, 0.28, 0.3 + rng() * 0.2, C.rock, 0, rng() * 3);
      bamboo(b, (x0 + x1) / 2, w.maxZ - 0.9, rng);
      bamboo(b, (x0 + x1) / 2, w.minZ + 0.9, rng);
    }
    for (const s of ['minZ', 'maxZ']) {
      const sd = side(a, s);
      for (const [u0, u1] of spans(sd.from + 0.6, sd.to - 0.6, sd.openings.map(([o0, o1]) => [o0 - 0.5, o1 + 0.5]))) {
        const z0 = sd.line - sd.nz * 0.4, z1 = sd.line - sd.nz * 1.0;
        hedge(b, u0, Math.min(z0, z1), u1, Math.max(z0, z1));
      }
    }
    leaves(b, a, rng, 20);
  }
}

function leaves(b, a, rng, n) {
  const f = a.floor;
  for (let i = 0; i < n; i++) {
    const x = f.minX + rng() * (f.maxX - f.minX), z = f.minZ + rng() * (f.maxZ - f.minZ), r = 0.05 + rng() * 0.04, an = rng() * 6.28;
    b.poly([[x + Math.cos(an) * r, 0.006, z + Math.sin(an) * r], [x + Math.cos(an + 2.2) * r * 0.6, 0.006, z + Math.sin(an + 2.2) * r * 0.6], [x + Math.cos(an + 4.1) * r * 0.6, 0.006, z + Math.sin(an + 4.1) * r * 0.6]].reverse(), pick(rng, C.maple));
  }
}

function pavilion(B, a, ctx) {
  const { rng, lights } = ctx;
  const { cx, cz, rWall, rFloor } = a.disc;
  const b = B.m;
  // round floor: rings of pale stone with a gold inlay ring + abacus medallion
  const rings = 12, segs = 40;
  for (let i = 0; i < rings; i++) {
    const r0 = (i / rings) * (rWall + 1.0), r1 = ((i + 1) / rings) * (rWall + 1.0);
    for (let j = 0; j < segs; j++) {
      const a0 = j / segs * Math.PI * 2, a1 = (j + 1) / segs * Math.PI * 2;
      let col = (i + j) % 3 === 0 ? C.paveB : (i + j) % 3 === 1 ? C.paveC : C.paveA;
      if (i === 4) col = C.gold;
      if (i === 9) col = C.border;
      const ao = 0.86 + 0.14 * smooth(rWall + 0.2, rWall - 1.0, r1);
      b.poly([[cx + Math.sin(a0) * r0, 0, cz + Math.cos(a0) * r0], [cx + Math.sin(a0) * r1, 0, cz + Math.cos(a0) * r1], [cx + Math.sin(a1) * r1, 0, cz + Math.cos(a1) * r1], [cx + Math.sin(a1) * r0, 0, cz + Math.cos(a1) * r0]], mix(col, 0x000000, 1 - ao));
    }
  }
  for (let k = -2; k <= 2; k++) b.box(cx + k * 0.42, 0, cz, 0.04, 0.006, 1.8, C.gold);
  for (let k = 0; k < 9; k++) b.cyl(cx + (k % 5 - 2) * 0.42, 0, cz - 0.6 + Math.floor(k / 5) * 1.0 + (k % 2) * 0.2, 0.12, 0.008, C.gold, { seg: 8 });
  // tower body under the disc
  b.cyl(cx, -70, cz, rWall + 1.0, 69.75, C.facade, { seg: 24 });
  for (let y = -2.2; y > -60; y -= 3.4) b.cyl(cx, y - 1.6, cz, rWall + 1.02, 1.6, mix(C.facadeWin, 0xffd6a0, 0.15), { seg: 24 });
  // railing ring + columns + ring roof (gold trim)
  const n = 20;
  ringSegments(a, n, 0.22, (x, z, ang, segW) => {
    L.set(x, z, ang + Math.PI);
    L.box(b, 0, 0, -0.15, segW + 0.05, 0.42, 0.35, C.parapet);
    L.box(b, 0, 0.42, -0.15, segW + 0.1, 0.06, 0.42, C.coping);
    L.box(B.gl, 0, 0.48, -0.15, segW, 0.97, 0.02, C.glass);
    L.box(b, 0, 1.42, -0.15, segW + 0.05, 0.06, 0.08, C.brass);
  });
  const cols = 10;
  for (let i = 0; i < cols; i++) {
    const ang = (i + 0.5) / cols * Math.PI * 2;
    const x = cx + Math.sin(ang) * (rWall - 0.55), z = cz + Math.cos(ang) * (rWall - 0.55);
    if (inDoorway(a, x, z, 0.5)) continue;
    b.cyl(x, 0, z, 0.2, 4.3, C.white, { seg: 10 });
    b.cyl(x, 0, z, 0.28, 0.25, C.coping, { seg: 10 });
    b.cyl(x, 4.25, z, 0.27, 0.18, C.gold, { seg: 10 });
  }
  // ring roof (segments of a flat annulus at 4.45 m, gold fascia)
  for (let j = 0; j < 40; j++) {
    const a0 = j / 40 * Math.PI * 2, a1 = (j + 1) / 40 * Math.PI * 2, r0 = rWall - 1.3, r1 = rWall + 0.4;
    const p = (r, an, y) => [cx + Math.sin(an) * r, y, cz + Math.cos(an) * r];
    b.poly([p(r0, a0, 4.43), p(r1, a0, 4.43), p(r1, a1, 4.43), p(r0, a1, 4.43)], C.white, true);
    b.poly([p(r0, a0, 4.75), p(r1, a0, 4.75), p(r1, a1, 4.75), p(r0, a1, 4.75)], 0xb8862f);
    b.poly([p(r1, a0, 4.43), p(r1, a1, 4.43), p(r1, a1, 4.75), p(r1, a0, 4.75)], C.gold, true);
    b.poly([p(r0, a0, 4.43), p(r0, a1, 4.43), p(r0, a1, 4.75), p(r0, a0, 4.75)], C.gold, true);
  }
  // in the band: hedges, lanterns, Mr. Golden's desk
  for (let i = 0; i < cols; i++) {
    const ang = i / cols * Math.PI * 2;
    const x = cx + Math.sin(ang) * (rWall - 1.2), z = cz + Math.cos(ang) * (rWall - 1.2);
    if (inDoorway(a, x, z, 0.8)) continue;
    if (Math.abs(ang - 0) < 0.3) continue;
    if (i % 2) stoneLantern(b, x, z, lights);
    else b.blob(x, 0.35, z, 0.45, 0.4, 0.45, C.hedge, 1, ang);
  }
  L.set(cx, cz + rWall - 1.25, Math.PI);
  L.box(b, 0, 0.74, 0, 2.0, 0.07, 0.85, 0xf6f2ea, { top: 0xfbf8f2 });
  L.box(b, 0, 0.0, 0, 1.8, 0.74, 0.7, C.gold);
  L.box(b, -0.3, 0.81, 0.1, 0.42, 0.01, 0.3, 0xffffff, null, 0.2);
  L.box(b, 0.25, 0.81, 0.05, 0.42, 0.01, 0.3, 0xfdfbf6, null, -0.15);
  L.box(b, 0.5, 0.81, 0.15, 0.14, 0.02, 0.01, 0x222222);
  L.box(b, 0, 0.0, -0.8, 0.7, 1.4, 0.12, C.gold);
  L.box(b, 0, 0.45, -0.6, 0.65, 0.1, 0.5, 0xb8402f);
}

function lobby(B, a, ctx) {
  const { rng, lights } = ctx;
  const w = a.wall, b = B.m;
  paving(b, a, w.minX - 0.9, w.minZ - 0.9, w.maxX + 0.9, w.maxZ + 0.9);
  for (const s of ['maxZ', 'minX', 'maxX']) railingSide(B, a, s);
  towerBody(b, { minX: w.minX - 0.9, maxX: w.maxX + 0.9, minZ: w.minZ - 0.9, maxZ: w.maxZ + 0.9 }, rng);
  // elevator kiosk at -Z: glass box with brass frame and a gold door
  const z0 = w.minZ - 0.9, z1 = w.minZ + 0.6;
  b.boxMM(w.minX - 0.9, 0, z0, w.maxX + 0.9, 3.4, z0 + 0.3, C.white);
  b.boxMM(w.minX - 0.9, 3.4, z0, w.maxX + 0.9, 3.6, z1 + 0.2, C.gold);
  b.boxMM(a.center.x - 0.9, 0, z0 + 0.3, a.center.x + 0.9, 2.5, z0 + 0.34, 0xd9a441);
  b.boxMM(a.center.x - 0.02, 0, z0 + 0.34, a.center.x + 0.02, 2.5, z0 + 0.36, 0x9c7430);
  for (const x of [w.minX - 0.8, w.maxX + 0.8]) b.boxMM(x - 0.06, 0, z0, x + 0.06, 3.4, z1 + 0.2, C.brass);
  B.gl.boxMM(w.minX - 0.8, 0, z1 + 0.15, a.center.x - 1.1, 3.4, z1 + 0.17, C.glass);
  B.gl.boxMM(a.center.x + 1.1, 0, z1 + 0.15, w.maxX + 0.8, 3.4, z1 + 0.17, C.glass);
  b.glow(1.3); b.box(a.center.x, 2.65, z0 + 0.36, 0.6, 0.18, 0.02, 0xfff0c8); b.glow(0);
  maple(b, w.minX + 1.0, a.center.z + 0.6, 1.0, rng);
  maple(b, w.maxX - 1.0, a.center.z + 0.6, 1.1, rng);
  stoneLantern(b, w.minX + 0.6, w.maxZ - 0.7, lights);
  stoneLantern(b, w.maxX - 0.6, w.maxZ - 0.7, lights);
}

function bridge(B, c, ctx) {
  const b = B.m;
  const x0 = c.x - c.w / 2, x1 = c.x + c.w / 2;
  b.floor(x0, c.zA, x1, c.zB, 0, 0.6, (ix, iz) => ((ix + iz) % 2 ? C.paveA : C.paveB));
  b.boxMM(x0 - 0.35, -0.7, c.zA, x1 + 0.35, -0.02, c.zB, C.coping, { bottom: true });
  b.boxMM(x0 - 0.36, -0.75, c.zA, x1 + 0.36, -0.6, c.zB, C.brass, { bottom: true });
  for (const [x, nx] of [[x0, -1], [x1, 1]]) {
    const sd = { s: 'b', axis: 'z', line: x, from: c.zA, to: c.zB, nx, nz: 0, openings: [] };
    sideBox(b, sd, c.zA, c.zB, 0, 0.3, 0, 0.3, C.parapet);
    sideBox(B.gl, sd, c.zA, c.zB, 0.14, 0.16, 0.3, 1.35, C.glass);
    sideBox(b, sd, c.zA, c.zB, 0.1, 0.2, 1.32, 1.38, C.brass);
    for (let z = c.zA + 0.1; z < c.zB; z += 1.4) sideBox(b, sd, z, z + 0.05, 0.12, 0.18, 0.3, 1.32, C.brass);
  }
}

function gateFrame(b, gate) {
  const hw = gate.w / 2;
  for (const s of [-1, 1]) {
    b.boxMM(gate.x + s * hw - 0.1, 0, gate.z - 0.12, gate.x + s * hw + 0.1, 2.75, gate.z + 0.12, C.white);
    b.boxMM(gate.x + s * hw - 0.12, 2.75, gate.z - 0.14, gate.x + s * hw + 0.12, 2.9, gate.z + 0.14, C.gold);
  }
  b.boxMM(gate.x - hw - 0.12, 2.9, gate.z - 0.16, gate.x + hw + 0.12, 3.05, gate.z + 0.16, C.gold);
  b.boxMM(gate.x - hw, -0.01, gate.z - 0.1, gate.x + hw, 0.005, gate.z + 0.1, C.brass);
}

export function gate(g) {
  const frame = new MeshBuilder(), pane = new MeshBuilder();
  const w = g.w - 0.16, h = 2.6;
  frame.box(0, 0, 0, w, 0.08, 0.08, C.brass);
  frame.box(0, h - 0.08, 0, w, 0.08, 0.08, C.brass);
  frame.box(-w / 2 + 0.04, 0, 0, 0.08, h, 0.08, C.brass);
  frame.box(w / 2 - 0.04, 0, 0, 0.08, h, 0.08, C.brass);
  frame.box(0, 1.25, 0, w, 0.04, 0.06, C.brass);
  pane.box(0, 0.08, 0, w - 0.16, h - 0.16, 0.025, 0xe8f6f8);
  return {
    leaves: [
      { builder: frame, anim: 'sink', amount: h + 0.1, pivot: [0, 0, 0] },
      { builder: pane, mat: 'glass', anim: 'sink', amount: h + 0.1, pivot: [0, 0, 0] },
    ],
    openTime: 0.8, closeTime: 0.55,
  };
}

function exterior(B, layout, ctx) {
  const { rng } = ctx;
  const b = B.m, bd = layout.bounds;
  const cx = (bd.minX + bd.maxX) / 2, cz = (bd.minZ + bd.maxZ) / 2;
  // skyline in layered haze: colour-only atmospheric perspective (far = paler, warmer, self-lit by the haze)
  for (let i = 0; i < 110; i++) {
    const ang = rng() * Math.PI * 2;
    const r = 85 + rng() * 170;
    const x = cx + Math.sin(ang) * r, z = cz + Math.cos(ang) * r;
    const t = Math.min(1, (r - 85) / 170);
    const w = 9 + rng() * 16, d = 9 + rng() * 16;
    const top = -38 + rng() * 34 + (rng() < 0.12 ? 22 : 0);
    const col = mix(mix(0x9fb0c8, 0xf2d2b0, t * 0.85), 0xffffff, 0.08);
    b.glow(0.12 + 0.4 * t);
    b.box(x, -95, z, w, top + 95, d, col, rng() * 1.5);
    if (rng() < 0.35) b.box(x, top, z, w * 0.55, 3 + rng() * 9, d * 0.55, mix(col, 0xffffff, 0.06), rng());
    if (rng() < 0.15) b.cyl(x, top, z, 0.25, 6 + rng() * 6, col, { seg: 4 });
  }
  b.glow(0);
}

export function build(ctx) {
  const { layout } = ctx;
  for (const a of layout.areas) {
    const B = ctx.B(a);
    if (a.kind === 'start') lobby(B, a, ctx);
    else if (a.kind === 'corridor') bridge(B, a, ctx);
    else if (a.shape === 'disc') pavilion(B, a, ctx);
    else terrace(B, a, ctx);
  }
  for (const g of layout.gates) gateFrame(ctx.B(g.corridor).m, g);
  exterior(ctx.ext, layout, ctx);
}

export default { id: 'tower', light, build, gate };
