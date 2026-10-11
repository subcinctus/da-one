// Chapter 1: The Laundromat. Mint / cream tiles, rows of washers and dryers, folding tables, big street
// windows with low morning sun pouring in, a sunlit back alley with laundry lines.
import { MeshBuilder, mix, lin } from '../geo.js';
import { wallSide, side, sideBox, slots, corridorShell, ceiling, inDoorway } from '../kit.js';
import { Local, plant, stool, crate, sack } from '../props.js';

const DOOR_H = 2.7;
const C = {
  tileA: 0xa6dcc8, tileB: 0xf5efe1, tileEdge: 0x6fbfa6, tileBand: 0xece4d2,
  wall: 0xf3ead8, wainscot: 0x8fd0b9, trim: 0xfbf8f1, skirt: 0x5fa892, ceiling: 0xf6f2e8, panel: 0xfffbf2,
  frame: 0xf8f6f0, glass: 0xcfe8f0,
  washer: 0xf5f4ef, washerTop: 0xe9eae5, washerPanel: 0xbfe3d6, chrome: 0xc9d0d4, porthole: 0x3a4d57, kick: 0xd7d9d4,
  dryer: 0xe3e6e5, dryerStrip: 0x7fc8b0,
  laminate: 0xeee2c8, leg: 0xb8c0c4, wood: 0xc79a6a, woodDark: 0x9c7450,
  basket: [0xf2a7a0, 0x9fcbe8, 0xf6d488, 0xc3b3e6, 0xa8dcc0],
  cloth: [0xf7f3ea, 0xe9a9a3, 0xa9c9e8, 0xf3d9a0, 0xd3c4ec, 0xb9e0cf, 0xf0b98f],
  brick: 0xbd7e66, brickB: 0xa96d58, brickC: 0xcc927a, mortar: 0xd2b4a4, asphalt: 0x7f8488, asphaltB: 0x8a8f93,
  dumpster: 0x4f8a6b, steel: 0x9aa3a8, darkGlass: 0x4c5d68,
  sidewalk: 0xd9d4c9, curb: 0xc7c2b8, road: 0x868b90, lane: 0xf2efe6,
  facades: [0xf2c9b5, 0xf3e3b3, 0xbcd9e6, 0xd8e8c9, 0xf0d0d8, 0xe9e3d6],
  shutterA: 0xc3cacd, shutterB: 0xb1b9bd, shutterBar: 0x7f888d,
};

export const light = {
  sunDir: [0.8, 0.43, -0.42], sun: 0xffecca, sunI: 3.3,
  hemiSky: 0xe8f4f1, hemiGround: 0xe0d4c0, hemiI: 1.45, exposure: 1.0,
  sky: { top: 0x7fb7e2, mid: 0xbcdcee, horizon: 0xf7ead2, bottom: 0xe3d9c7, sun: 0xfff3da, sunSize: 0.0016, halo: 1.0, midH: 0.3 },
};

const L = new Local();
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
/** AO multiplier near the walls of an area. */
function wallAO(a, x, z, min = 0.8, reach = 1.0) {
  const w = a.wall;
  const d = Math.min(x - w.minX, w.maxX - x, z - w.minZ, w.maxZ - z);
  return min + (1 - min) * smooth(0, reach, d);
}

// ------------------------------------------------------------------ props

function washer(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 0.7, 0.88, 0.7, C.washer, { top: C.washerTop });
  L.box(b, 0, 0.88, -0.23, 0.7, 0.16, 0.22, C.washerPanel);
  L.box(b, -0.17, 0.95, -0.115, 0.16, 0.05, 0.012, 0x33434b);
  L.disc(b, 0.17, 0.97, -0.115, 0.035, 0.03, C.chrome, 8);
  L.disc(b, 0, 0.5, 0.36, 0.235, 0.05, C.chrome, 16);
  L.disc(B.g, 0, 0.5, 0.385, 0.18, 0.02, C.porthole, 16);
  L.box(b, 0, 0, 0.352, 0.62, 0.07, 0.01, C.kick);
}

function dryerStack(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 0.8, 1.95, 0.72, C.dryer, { top: 0xd0d4d4 });
  L.box(b, 0, 0.93, 0.362, 0.8, 0.08, 0.01, C.dryerStrip);
  L.box(b, 0, 1.86, 0.362, 0.8, 0.09, 0.01, C.dryerStrip);
  for (const y of [0.5, 1.4]) {
    L.disc(b, 0, y, 0.37, 0.27, 0.05, C.chrome, 16);
    L.disc(B.g, 0, y, 0.395, 0.21, 0.02, C.porthole, 16);
    L.box(b, 0.31, y + 0.2, 0.362, 0.08, 0.05, 0.015, 0x3a3f42);
  }
}

function foldingTable(B, x, z, yaw, rng, len = 1.7) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0.86, 0, len, 0.05, 0.72, C.laminate);
  L.box(b, 0, 0.84, 0, len - 0.04, 0.03, 0.68, 0xd8ccb2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.box(b, sx * (len / 2 - 0.08), 0, sz * 0.28, 0.04, 0.84, 0.04, C.leg);
  L.box(b, 0, 0.15, 0, len - 0.2, 0.03, 0.6, C.leg);
  // folded stacks + a basket
  let u = -len / 2 + 0.3;
  while (u < len / 2 - 0.25) {
    if (rng() < 0.35) {
      const c = C.basket[Math.floor(rng() * C.basket.length)];
      L.box(b, u, 0.91, (rng() - 0.5) * 0.15, 0.42, 0.24, 0.32, c, null, (rng() - 0.5) * 0.4);
      L.box(b, u, 1.15, 0, 0.38, 0.06, 0.28, mix(C.cloth[Math.floor(rng() * C.cloth.length)], 0xffffff, 0.1));
      u += 0.55;
    } else {
      const n = 1 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) L.box(b, u + (rng() - 0.5) * 0.04, 0.91 + i * 0.055, (rng() - 0.5) * 0.12, 0.34, 0.055, 0.28, C.cloth[Math.floor(rng() * C.cloth.length)], null, (rng() - 0.5) * 0.15);
      u += 0.45;
    }
  }
}

function shelf(B, x, z, yaw, rng) {
  const b = B.m;
  L.set(x, z, yaw);
  for (const sx of [-0.58, 0.58]) for (const sz of [-0.2, 0.2]) L.box(b, sx, 0, sz, 0.04, 2.0, 0.04, C.leg);
  for (const y of [0.12, 0.62, 1.12, 1.62, 1.96]) {
    L.box(b, 0, y, 0, 1.22, 0.035, 0.46, 0xdfe3e2);
    if (y > 1.9) continue;
    let u = -0.5;
    while (u < 0.45) {
      const n = 2 + Math.floor(rng() * 4);
      const c = rng() < 0.3 ? 0xd8b98d : C.cloth[Math.floor(rng() * C.cloth.length)];
      if (c === 0xd8b98d) { L.box(b, u + 0.12, y + 0.035, 0, 0.26, 0.26, 0.34, c); u += 0.32; continue; }
      for (let i = 0; i < n; i++) L.box(b, u + 0.12, y + 0.035 + i * 0.06, 0, 0.28, 0.06, 0.34, c);
      u += 0.33;
    }
  }
}

function cart(B, x, z, yaw, rng) {
  const b = B.m;
  L.set(x, z, yaw);
  const col = C.basket[Math.floor(rng() * C.basket.length)];
  L.box(b, 0, 0.18, 0, 0.62, 0.55, 0.48, mix(col, 0xffffff, 0.15));
  for (const sx of [-0.31, 0.31]) for (const sz of [-0.24, 0.24]) {
    L.box(b, sx, 0.08, sz, 0.03, 0.7, 0.03, C.leg);
    L.cyl(b, sx, 0, sz, 0.04, 0.08, 0x3b3f42, { seg: 6 });
  }
  L.box(b, 0, 0.74, 0.24, 0.66, 0.03, 0.03, C.leg);
  L.box(b, 0, 0.74, -0.24, 0.66, 0.03, 0.03, C.leg);
  for (let i = 0; i < 3; i++) L.blob(b, (rng() - 0.5) * 0.3, 0.75 + rng() * 0.05, (rng() - 0.5) * 0.2, 0.2, 0.1, 0.16, C.cloth[Math.floor(rng() * C.cloth.length)]);
}

function vending(B, x, z, yaw, lights) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 0.95, 1.9, 0.75, 0x2f8f7c, { top: 0x27786a });
  b.glow(1.1);
  L.box(b, -0.1, 0.75, 0.376, 0.6, 1.0, 0.01, 0xe9f4ee);
  b.glow(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) L.box(b, -0.33 + c * 0.15, 0.82 + r * 0.24, 0.39, 0.1, 0.14, 0.02, C.cloth[(r * 4 + c) % C.cloth.length]);
  L.box(b, 0.33, 1.0, 0.38, 0.16, 0.3, 0.02, 0x1e2b2b);
  L.box(b, 0, 0.15, 0.38, 0.75, 0.2, 0.02, 0x1e2b2b);
  lights.push({ x: L.px(0, 0.9), y: 1.2, z: L.pz(0, 0.9), color: lin(0xd9fff0), intensity: 0.35, range: 2.4 });
}

function changeMachine(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 0.6, 1.5, 0.4, 0xe8dfc9, { top: 0xd9cfb6 });
  L.box(b, 0, 1.0, 0.2, 0.4, 0.25, 0.02, 0x3b4a50);
  L.box(b, 0, 0.55, 0.205, 0.3, 0.08, 0.02, C.chrome);
  L.box(b, 0, 1.5, 0, 0.6, 0.12, 0.4, 0xe0553f);
}

function poster(b, sd, u, y, w, h, color, frameColor = 0xfbf8f1) {
  sideBox(b, sd, u - w / 2 - 0.03, u + w / 2 + 0.03, -0.03, 0, y - 0.03, y + h + 0.03, frameColor);
  sideBox(b, sd, u - w / 2, u + w / 2, -0.04, -0.03, y, y + h, color);
}

function clock(b, sd, u, y) {
  const p = sd.axis === 'x' ? { x: u, z: sd.line - sd.nz * 0.03 } : { x: sd.line - sd.nx * 0.03, z: u };
  L.set(p.x, p.z, Math.atan2(-sd.nx, -sd.nz));
  L.disc(b, 0, y, 0, 0.24, 0.05, 0x2f3437, 16);
  L.disc(b, 0, y, 0.02, 0.2, 0.03, 0xfbf8f1, 16);
  L.box(b, 0, y - 0.01, 0.04, 0.02, 0.15, 0.01, 0x2f3437);
  L.box(b, 0.05, y - 0.01, 0.04, 0.11, 0.02, 0.01, 0x2f3437);
}

function bench(B, x, z, yaw, len) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0.42, 0, len, 0.06, 0.42, C.wood, { top: 0xd2a676 });
  for (const s of [-1, 1]) { L.box(b, s * (len / 2 - 0.15), 0, 0, 0.05, 0.42, 0.36, C.leg); }
}

function steamPress(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, -0.05, 1.1, 0.78, 0.6, 0xd8dcdb, { top: 0xcfd4d3 });
  L.box(b, 0, 0.78, 0.02, 1.15, 0.12, 0.62, 0xf1ece2);
  L.box(b, 0, 0.9, 0.0, 1.0, 0.05, 0.55, 0x9fd3c1);
  L.box(b, 0, 0.78, -0.3, 0.2, 0.75, 0.2, 0xc6cbca);
  L.box(b, 0, 1.38, -0.1, 1.1, 0.14, 0.58, 0xbfc5c4, null);
  L.box(b, 0, 1.36, 0.25, 0.7, 0.04, 0.05, 0x33393b);
  L.cyl(b, 0.42, 0.55, 0.32, 0.03, 0.05, 0xe0553f, { seg: 6 });
}

function bigWasher(B, x, z, yaw) {
  const b = B.m;
  L.set(x, z, yaw);
  L.box(b, 0, 0, 0, 1.5, 1.7, 1.2, 0xe5e8e7, { top: 0xd6dad9 });
  L.disc(b, 0, 0.95, 0.6, 0.52, 0.08, C.chrome, 20);
  L.disc(B.g, 0, 0.95, 0.65, 0.42, 0.02, C.porthole, 20);
  L.box(b, 0, 1.7, -0.3, 1.5, 0.35, 0.5, C.washerPanel);
  L.box(b, -0.45, 1.8, -0.04, 0.35, 0.12, 0.01, 0x33434b);
  L.box(b, 0, 0, 0.62, 1.4, 0.1, 0.02, 0x9aa3a8);
}

function tadaoDesk(B, x, z, yaw, rng) {
  const b = B.m;
  L.set(x, z, yaw);
  // desk
  L.box(b, 0, 0.74, 0, 1.8, 0.06, 0.8, 0x7a5236, { top: 0x8a6040 });
  L.box(b, -0.65, 0, 0, 0.45, 0.74, 0.76, 0x6b4630);
  L.box(b, 0.65, 0, 0, 0.45, 0.74, 0.76, 0x6b4630);
  L.box(b, 0, 0.3, -0.36, 0.86, 0.44, 0.03, 0x6b4630);
  // ledger (open), pen, lamp, abacus
  L.box(b, -0.2, 0.8, 0.05, 0.5, 0.035, 0.34, 0xf5efdf);
  L.box(b, -0.2, 0.8, 0.05, 0.02, 0.04, 0.34, 0x8b2f2a);
  L.box(b, 0.05, 0.8, 0.08, 0.16, 0.01, 0.01, 0x222222);
  L.box(b, 0.45, 0.8, -0.1, 0.62, 0.06, 0.22, 0x5a3b26);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) L.box(b, 0.2 + c * 0.1, 0.86, -0.18 + r * 0.04, 0.045, 0.035, 0.03, (r + c) % 3 ? 0xd9a441 : 0x8b2f2a);
  b.glow(1.6);
  L.box(b, -0.7, 1.14, -0.2, 0.22, 0.12, 0.22, 0xffe2a8);
  b.glow(0);
  L.box(b, -0.7, 0.8, -0.2, 0.04, 0.35, 0.04, 0x2f3437);
  // chair
  L.box(b, 0, 0.45, -0.75, 0.55, 0.08, 0.52, 0x2f3437);
  L.box(b, 0, 0.5, -1.0, 0.55, 0.65, 0.07, 0x2f3437);
  L.cyl(b, 0, 0, -0.75, 0.04, 0.45, C.leg, { seg: 6 });
  // stacks of ledgers
  for (let i = 0; i < 4; i++) L.box(b, 0.75, 0.8 + i * 0.05, 0.22, 0.3, 0.05, 0.22, i % 2 ? 0x2f4f6f : 0x8b2f2a, null, (rng() - 0.5) * 0.2);
}

// ------------------------------------------------------------------ shells

function tileFn(a) {
  const f = a.floor;
  return (ix, iz, x, z) => {
    const inFloor = x > f.minX && x < f.maxX && z > f.minZ && z < f.maxZ;
    if (!inFloor) return C.tileBand;
    const edge = x < f.minX + 0.5 || x > f.maxX - 0.5 || z < f.minZ + 0.5 || z > f.maxZ - 0.5;
    if (edge) return C.tileEdge;
    return (ix + iz) % 2 ? C.tileA : C.tileB;
  };
}

function windowWall(B, a, H, sill = 0.85, top = 3.0) {
  const sd = side(a, 'maxX'), b = B.m;
  b.setAO(0.82, 1.4);
  sideBox(b, sd, sd.from, sd.to, 0, 0.3, 0, sill, C.wall);
  sideBox(b, sd, sd.from, sd.to, -0.02, 0, 0, sill, C.wainscot);
  sideBox(b, sd, sd.from, sd.to, -0.03, 0, 0, 0.12, C.skirt);
  b.noAO();
  sideBox(b, sd, sd.from, sd.to, -0.2, 0.32, sill, sill + 0.05, C.trim);
  sideBox(b, sd, sd.from, sd.to, 0, 0.3, top, H, C.wall);
  const n = Math.max(2, Math.round((sd.to - sd.from) / 2.2));
  for (let i = 0; i <= n; i++) {
    const u = sd.from + (sd.to - sd.from) * (i / n);
    sideBox(b, sd, u - 0.08, u + 0.08, 0.04, 0.26, sill, top, C.frame);
  }
  sideBox(b, sd, sd.from, sd.to, 0.08, 0.22, 2.4, 2.47, C.frame);
  sideBox(b, sd, sd.from, sd.to, 0.04, 0.26, top - 0.06, top, C.frame);
  sideBox(B.gl, sd, sd.from, sd.to, 0.14, 0.16, sill, top, C.glass);
  return sd;
}

function roomShell(B, a, ctx) {
  const b = B.m, w = a.wall, H = a.ceil;
  b.floor(w.minX, w.minZ, w.maxX, w.maxZ, 0, 0.5, tileFn(a), (x, z) => wallAO(a, x, z));
  b.setAO(0.8, 1.5);
  for (const s of ['minZ', 'maxZ', 'minX']) {
    wallSide(b, a, s, { h: H, color: C.wall, wainscot: C.wainscot, wainscotH: 1.15, trim: C.trim, skirting: C.skirt, doorH: DOOR_H, lintel: C.wall });
  }
  b.noAO();
  // crown band under the ceiling (mint stripe + cream moulding)
  for (const s of ['minZ', 'maxZ', 'minX', 'maxX']) {
    const sd = side(a, s);
    sideBox(b, sd, sd.from, sd.to, -0.04, 0, H - 0.32, H - 0.26, C.wainscot);
    sideBox(b, sd, sd.from, sd.to, -0.06, 0, H - 0.2, H, C.trim);
  }
  windowWall(B, a, H, a.boss ? 1.3 : 0.85, a.boss ? 3.5 : 3.0);
  b.glow(0.32);
  ceiling(b, { minX: w.minX - 0.3, maxX: w.maxX + 0.3, minZ: w.minZ - 0.3, maxZ: w.maxZ + 0.3 }, H, 0.3, C.ceiling);
  b.glow(0);
  // fluorescent panels
  const f = a.floor;
  const nx = Math.max(2, Math.round((f.maxX - f.minX) / 3.2)), nz = Math.max(2, Math.round((f.maxZ - f.minZ) / 3.2));
  b.glow(1.25);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = f.minX + (f.maxX - f.minX) * ((i + 0.5) / nx), z = f.minZ + (f.maxZ - f.minZ) * ((j + 0.5) / nz);
    b.box(x, H - 0.05, z, 1.4, 0.05, 0.3, C.panel);
    ctx.lights.push({ x, y: H - 0.3, z, color: lin(0xfff6e6), intensity: 0.22, range: 4.2 });
  }
  b.glow(0);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = f.minX + (f.maxX - f.minX) * ((i + 0.5) / nx), z = f.minZ + (f.maxZ - f.minZ) * ((j + 0.5) / nz);
    b.box(x, H - 0.07, z, 1.5, 0.03, 0.38, 0xe2ded3);
  }
}

// ------------------------------------------------------------------ rooms

function dressRoom(B, a, ctx) {
  const { rng, lights } = ctx;
  const b = B.m;
  const sMinX = side(a, 'minX'), sMinZ = side(a, 'minZ'), sMaxZ = side(a, 'maxZ'), sMaxX = side(a, 'maxX');
  const i = a.index;
  if (i === 0) {
    // Folding room: linen shelves, folding tables under the windows, carts, a water heater
    for (const s of slots(a, 'minX', 1.35, 0.33)) shelf(B, s.x, s.z, s.yaw, rng);
    for (const s of slots(a, 'maxX', 2.0, 0.55)) foldingTable(B, s.x, s.z, s.yaw, rng, 1.75);
    const zs = slots(a, 'minZ', 1.0, 0.45);
    zs.forEach((s, k) => { if (k % 2) cart(B, s.x, s.z, s.yaw + (rng() - 0.5) * 0.5, rng); else crate(b, s.x, 0, s.z, 0.55, 0xd8b98d, s.yaw + rng() * 0.3); });
    const back = slots(a, 'maxZ', 0.82, 0.4);
    back.forEach((s, k) => { if (k < 2 || k >= back.length - 2) washer(B, s.x, s.z, s.yaw); else cart(B, s.x, s.z, s.yaw, rng); });
    b.cyl(a.wall.minX + 0.55, 0, a.wall.minZ + 0.55, 0.32, 1.8, 0xe8e9e6, { seg: 12 });
    b.cyl(a.wall.minX + 0.55, 1.8, a.wall.minZ + 0.55, 0.26, 0.12, 0xd0d3d2, { seg: 12 });
    b.bar(a.wall.minX + 0.55, 1.9, a.wall.minZ + 0.55, a.wall.minX + 0.55, a.ceil, a.wall.minZ + 0.55, 0.05, C.chrome);
    poster(b, sMinZ, a.wall.minX + 2.6, 1.55, 0.6, 0.8, 0xf2a7a0);
    clock(b, sMaxZ, a.corridorOut ? a.corridorOut.x : 0, 3.15);
  } else if (i === 1) {
    // Wash floor: washers along the inner wall + back wall, bench under the windows, vending corner
    for (const s of slots(a, 'minX', 0.76, 0.4, 0.3, 0.1)) washer(B, s.x, s.z, s.yaw);
    for (const s of slots(a, 'maxZ', 0.76, 0.4, 0.5, 0.2)) washer(B, s.x, s.z, s.yaw);
    const ws = slots(a, 'maxX', 2.4, 0.45);
    ws.forEach((s, k) => { if (k % 2) bench(B, s.x, s.z, s.yaw, 1.8); else { stool(b, s.x + 0.0, s.z - 0.5, 0xe0553f, C.leg); stool(b, s.x, s.z + 0.5, 0xf2a7a0, C.leg); } });
    plant(b, a.wall.maxX - 0.5, a.wall.minZ + 0.5, 1.2, 0xe8dcc8, 0x5f9a6a, rng);
    plant(b, a.wall.maxX - 0.5, a.wall.maxZ - 0.5, 1.1, 0xe8dcc8, 0x6aa673, rng);
    const fs = slots(a, 'minZ', 1.05, 0.42, 0.5);
    fs.forEach((s, k) => {
      if (k === 0) vending(B, s.x, s.z, s.yaw, lights);
      else if (k === 1) changeMachine(B, s.x, s.z, s.yaw);
      else if (k === fs.length - 1) plant(b, s.x, s.z, 1, 0xe8dcc8, 0x5f9a6a, rng);
      else cart(B, s.x, s.z, s.yaw + (rng() - 0.5) * 0.4, rng);
    });
    // signage band over the washers
    sideBox(b, sMinX, a.wall.minZ + 0.6, a.wall.maxZ - 0.6, -0.04, 0, 2.15, 2.6, 0x6fbfa6);
    for (let k = 0; k < 5; k++) sideBox(b, sMinX, a.center.z - 1.6 + k * 0.7, a.center.z - 1.2 + k * 0.7, -0.05, -0.04, 2.25, 2.5, 0xfbf8f1);
    clock(b, sMaxZ, a.wall.maxX - 2.2, 2.9);
    poster(b, sMinZ, a.wall.maxX - 3.0, 1.5, 0.7, 0.9, 0x9fcbe8);
  } else if (i === 2) {
    // Dryer hall: stacked dryers on two walls, folding tables, laundry bags
    for (const s of slots(a, 'minX', 0.86, 0.4, 0.3, 0.1)) dryerStack(B, s.x, s.z, s.yaw);
    for (const s of slots(a, 'maxZ', 0.86, 0.4, 0.5, 0.2)) dryerStack(B, s.x, s.z, s.yaw);
    for (const s of slots(a, 'maxX', 2.1, 0.55)) foldingTable(B, s.x, s.z, s.yaw, rng, 1.8);
    const fs = slots(a, 'minZ', 0.9, 0.45, 0.5);
    fs.forEach((s, k) => { if (k % 3 === 0) sack(b, s.x, s.z, 1.1, C.cloth[k % C.cloth.length], rng); else if (k % 3 === 1) cart(B, s.x, s.z, s.yaw, rng); else crate(b, s.x, 0, s.z, 0.5, 0xd8b98d, rng()); });
    poster(b, sMinZ, a.wall.maxX - 2.4, 1.5, 0.6, 0.85, 0xf6d488);
    clock(b, sMaxZ, a.center.x, 2.95);
  } else {
    // Pressing room (boss): presses, industrial washers, Tadao's desk at the back
    for (const s of slots(a, 'minX', 1.6, 0.45, 0.4)) steamPress(B, s.x, s.z, s.yaw);
    const fz = slots(a, 'minZ', 1.75, 0.65, 0.5);
    fz.forEach((s) => bigWasher(B, s.x, s.z, s.yaw));
    tadaoDesk(B, a.center.x + 0.6, a.wall.maxZ - 0.95, Math.PI, rng);
    // filing cabinets + safe + calligraphy
    for (let k = 0; k < 3; k++) { const x = a.wall.minX + 1.0 + k * 0.6; L.set(x, a.wall.maxZ - 0.35, Math.PI); L.box(b, 0, 0, 0, 0.55, 1.35, 0.6, 0x9aa69f, { top: 0x8b968f }); for (let d = 0; d < 3; d++) L.box(b, 0, 0.15 + d * 0.42, 0.305, 0.4, 0.04, 0.02, C.chrome); }
    L.set(a.wall.maxX - 1.0, a.wall.maxZ - 0.5, Math.PI); L.box(b, 0, 0, 0, 0.8, 0.95, 0.75, 0x3c4245, { top: 0x2f3437 }); L.disc(b, 0.1, 0.55, 0.38, 0.12, 0.04, 0xd9a441, 12);
    poster(b, sMaxZ, a.center.x + 0.6, 1.9, 1.0, 1.4, 0xf5efdf, 0x3a2a20);
    sideBox(b, sMaxZ, a.center.x + 0.3, a.center.x + 0.4, -0.05, -0.04, 2.1, 3.0, 0x2a2a2a);
    sideBox(b, sMaxZ, a.center.x + 0.7, a.center.x + 0.8, -0.05, -0.04, 2.2, 2.8, 0x2a2a2a);
    // garment rail with wrapped garments along the window wall
    const rx = a.wall.maxX - 0.5;
    b.bar(rx, 3.1, a.wall.minZ + 1.2, rx, 3.1, a.wall.maxZ - 1.6, 0.03, C.chrome);
    for (let z = a.wall.minZ + 1.4; z < a.wall.maxZ - 1.7; z += 0.32) {
      if (inDoorway(a, rx, z)) continue;
      const c = C.cloth[Math.floor(rng() * C.cloth.length)];
      b.box(rx, 1.9 + rng() * 0.15, z, 0.48, 1.1, 0.06, mix(c, 0xffffff, 0.35));
      b.bar(rx, 3.0, z, rx, 3.1, z, 0.008, C.chrome, 4);
    }
    clock(b, sMinZ, a.wall.minX + 2.2, 3.4);
    sideBox(b, sMaxX, a.wall.minZ + 0.6, a.wall.maxZ - 0.6, -0.04, 0, 2.4, 2.75, 0x6fbfa6);
  }
}

// ------------------------------------------------------------------ alley (start)

function brickWall(b, x0, z0, x1, z1, h, rng, face) {
  // face: +1/-1 along the wall normal axis for detail bricks; wall runs along X (z0==z1) or Z (x0==x1)
  b.boxMM(x0, 0, z0, x1, h, z1, C.brick);
  const alongX = Math.abs(z1 - z0) < Math.abs(x1 - x0);
  const len = alongX ? x1 - x0 : z1 - z0;
  const n = Math.floor(len * h * 3.2);
  for (let i = 0; i < n; i++) {
    const u = rng() * len, y = Math.floor(rng() * h / 0.09) * 0.09;
    const c = rng() < 0.5 ? C.brickB : C.brickC;
    if (alongX) b.box(x0 + u, y, (face > 0 ? Math.max(z0, z1) : Math.min(z0, z1)) + face * 0.006, 0.24, 0.075, 0.012, c);
    else b.box((face > 0 ? Math.max(x0, x1) : Math.min(x0, x1)) + face * 0.006, y, z0 + u, 0.012, 0.075, 0.24, c);
  }
}

function alley(B, a, ctx) {
  const { rng, lights } = ctx;
  const b = B.m, w = a.wall;
  // ground: asphalt with a drain channel, puddles
  b.floor(w.minX - 0.3, w.minZ - 0.3, w.maxX + 0.3, w.maxZ, 0, 0.5, (ix, iz, x) => (Math.abs(x - a.center.x) < 0.25 ? 0x6c7175 : (ix * 7 + iz * 3) % 5 === 0 ? C.asphaltB : C.asphalt), (x, z) => wallAO(a, x, z, 0.75, 1.2));
  for (const [px, pz, sx, sz] of [[a.center.x - 1.2, w.minZ + 3.0, 1.4, 0.8], [a.center.x + 1.1, w.minZ + 6.6, 1.0, 1.3], [a.center.x - 0.6, w.minZ + 8.6, 0.8, 0.6]]) {
    B.g.quad(px - sx / 2, pz - sz / 2, px + sx / 2, pz + sz / 2, 0.006, 0x8fb2c4);
  }
  // tall building on -X with windows + fire escape
  brickWall(b, w.minX - 0.4, w.minZ - 0.4, w.minX, w.maxZ + 0.3, 8.5, rng, 1);
  for (let z = w.minZ + 1.2; z < w.maxZ - 0.5; z += 2.6) {
    for (const y of [3.4, 6.0]) {
      b.boxMM(w.minX, y - 0.08, z - 0.55, w.minX + 0.06, y + 1.38, z + 0.55, 0xf1e8d6);
      b.boxMM(w.minX + 0.06, y, z - 0.47, w.minX + 0.07, y + 1.3, z + 0.47, C.darkGlass);
      b.boxMM(w.minX + 0.06, y + 0.62, z - 0.47, w.minX + 0.09, y + 0.68, z + 0.47, 0xf1e8d6);
    }
  }
  // fire escape
  const fx = w.minX + 0.6;
  b.boxMM(w.minX, 3.15, w.minZ + 2.4, fx + 0.35, 3.2, w.minZ + 6.8, 0x3d4447);
  b.bar(fx + 0.35, 3.2, w.minZ + 2.4, fx + 0.35, 3.2, w.minZ + 6.8, 0.02, 0x3d4447);
  b.bar(fx + 0.35, 4.0, w.minZ + 2.4, fx + 0.35, 4.0, w.minZ + 6.8, 0.025, 0x3d4447);
  for (let z = w.minZ + 2.4; z <= w.minZ + 6.81; z += 0.55) b.bar(fx + 0.35, 3.2, z, fx + 0.35, 4.0, z, 0.012, 0x3d4447, 4);
  for (let k = 0; k < 8; k++) b.bar(fx + 0.15, 0.9 + k * 0.28, w.minZ + 6.3, fx + 0.15, 0.9 + k * 0.28, w.minZ + 6.75, 0.015, 0x3d4447, 4);
  b.bar(fx + 0.15, 0.9, w.minZ + 6.3, fx + 0.15, 3.2, w.minZ + 6.3, 0.02, 0x3d4447, 4);
  b.bar(fx + 0.15, 0.9, w.minZ + 6.75, fx + 0.15, 3.2, w.minZ + 6.75, 0.02, 0x3d4447, 4);
  // drainpipe + AC units
  b.bar(w.minX + 0.12, 0, w.minZ + 1.0, w.minX + 0.12, 8.4, w.minZ + 1.0, 0.06, 0x8a9296, 6);
  b.box(w.minX + 0.3, 2.3, w.minZ + 8.2, 0.5, 0.45, 0.7, 0xe3e3dc);
  b.box(w.minX + 0.3, 5.0, w.minZ + 4.0, 0.5, 0.45, 0.7, 0xe3e3dc);
  // low wall on +X (lets the sun in) with a fence
  brickWall(b, w.maxX, w.minZ - 0.4, w.maxX + 0.35, w.maxZ + 0.3, 1.6, rng, -1);
  b.boxMM(w.maxX - 0.02, 1.6, w.minZ - 0.4, w.maxX + 0.37, 1.7, w.maxZ + 0.3, 0xc9a594);
  for (let z = w.minZ - 0.3; z < w.maxZ + 0.3; z += 1.8) b.bar(w.maxX + 0.17, 1.7, z, w.maxX + 0.17, 3.0, z, 0.03, 0x5a6266, 6);
  b.bar(w.maxX + 0.17, 3.0, w.minZ - 0.3, w.maxX + 0.17, 3.0, w.maxZ + 0.3, 0.025, 0x5a6266, 6);
  for (let z = w.minZ + 1.2; z < w.maxZ; z += 3.1) b.bar(w.maxX + 0.17, 3.0, z, w.maxX + 0.17, 3.5, z, 0.03, 0x5a6266, 6);
  B.gl.boxMM(w.maxX + 0.15, 1.7, w.minZ - 0.3, w.maxX + 0.19, 3.0, w.maxZ + 0.3, 0x9aa7ad);
  // back end: brick wall with a gate
  brickWall(b, w.minX - 0.4, w.minZ - 0.4, w.maxX + 0.35, w.minZ, 3.4, rng, 1);
  b.boxMM(a.center.x - 1.1, 0, w.minZ - 0.02, a.center.x + 1.1, 2.5, w.minZ + 0.05, 0x56635f);
  b.boxMM(a.center.x - 0.03, 0, w.minZ + 0.05, a.center.x + 0.03, 2.5, w.minZ + 0.07, 0x3d4745);
  // building facade over the back door (+Z): brick up to the roofline, windows, door lamp, awning
  const fz = w.maxZ;
  const room0 = a.corridorOut.to;
  const bx0 = room0.wall.minX - 0.3, bx1 = room0.wall.maxX + 0.3;
  b.boxMM(bx0, 0, fz - 0.03, a.corridorOut.x - a.corridorOut.w / 2, 3.2, fz, C.brick);
  b.boxMM(a.corridorOut.x + a.corridorOut.w / 2, 0, fz - 0.03, bx1, 3.2, fz, C.brick);
  brickWall(b, bx0, fz - 0.03, bx1, fz, 0.01, rng, -1);
  b.boxMM(bx0, 3.2, fz - 0.03, bx1, 8.6, fz + 1.2, C.brick);
  for (let x = bx0 + 1.2; x < bx1 - 0.8; x += 2.4) for (const y of [4.2, 6.6]) {
    b.boxMM(x - 0.55, y - 0.08, fz - 0.06, x + 0.55, y + 1.38, fz - 0.03, 0xf1e8d6);
    b.boxMM(x - 0.47, y, fz - 0.07, x + 0.47, y + 1.3, fz - 0.06, C.darkGlass);
  }
  b.boxMM(a.corridorOut.x - 1.9, 2.9, fz - 0.9, a.corridorOut.x + 1.9, 3.0, fz, 0x5fa892, { rx: 0 });
  b.glow(1.8);
  b.box(a.corridorOut.x, 2.72, fz - 0.15, 0.3, 0.12, 0.2, 0xfff0c8);
  b.glow(0);
  lights.push({ x: a.corridorOut.x, y: 2.5, z: fz - 0.4, color: lin(0xffe6b8), intensity: 0.6, range: 4.5 });
  b.boxMM(a.corridorOut.x - a.corridorOut.w / 2 - 0.12, 0, fz - 0.06, a.corridorOut.x - a.corridorOut.w / 2, DOOR_H + 0.12, fz, C.steel);
  b.boxMM(a.corridorOut.x + a.corridorOut.w / 2, 0, fz - 0.06, a.corridorOut.x + a.corridorOut.w / 2 + 0.12, DOOR_H + 0.12, fz, C.steel);
  // props: dumpster, bags, crates, bins, stacked baskets
  L.set(w.minX + 0.75, w.minZ + 1.6, Math.PI / 2);
  L.box(b, 0, 0.1, 0, 1.7, 1.05, 1.0, C.dumpster, { top: 0x3f7258 });
  L.box(b, 0, 1.15, -0.1, 1.75, 0.06, 1.05, 0x3a6a52, null);
  for (const s of [-0.7, 0.7]) L.cyl(b, s, 0, 0.4, 0.08, 0.12, 0x2a2d2f, { seg: 6 });
  for (let k = 0; k < 4; k++) sack(b, w.minX + 0.5 + rng() * 0.5, w.minZ + 2.9 + k * 0.35, 0.9 + rng() * 0.3, rng() < 0.5 ? 0x34393c : 0x4a5257, rng);
  crate(b, w.maxX - 0.5, 0, w.minZ + 5.2, 0.6, 0xc9a06a, 0.2);
  crate(b, w.maxX - 0.55, 0.48, w.minZ + 5.25, 0.5, 0xbf955f, -0.3);
  crate(b, w.maxX - 0.45, 0, w.minZ + 5.95, 0.55, 0xc9a06a, 0.5);
  b.cyl(w.minX + 0.45, 0, w.maxZ - 1.4, 0.28, 0.85, 0x5a6b73, { seg: 10 });
  b.cyl(w.minX + 0.45, 0.85, w.maxZ - 1.4, 0.3, 0.06, 0x4c5b62, { seg: 10 });
  b.cyl(w.minX + 0.45, 0, w.maxZ - 2.1, 0.28, 0.85, 0x4f8a6b, { seg: 10 });
  plant(b, w.maxX - 0.45, w.maxZ - 0.6, 1.1, 0xc4704f, 0x5f9a6a, rng);
  // laundry lines across the alley with sheets and towels
  for (const lz of [w.minZ + 4.3, w.minZ + 7.4]) {
    const y0 = 4.6, x0 = w.minX + 0.05, x1 = w.maxX + 0.17;
    b.beam(x0, y0, lz, x1, 3.4, lz, 0.015, 0.015, 0x3a3a3a);
    let x = x0 + 0.6;
    while (x < x1 - 0.6) {
      const t = (x - x0) / (x1 - x0), y = y0 + (3.4 - y0) * t - Math.sin(Math.PI * t) * 0.3;
      const wdt = 0.45 + rng() * 0.6, h = 0.45 + rng() * 0.6;
      b.box(x + wdt / 2, y - h, lz, wdt, h, 0.02, C.cloth[Math.floor(rng() * C.cloth.length)], 0, { bottom: true });
      x += wdt + 0.12 + rng() * 0.3;
    }
  }
}

// ------------------------------------------------------------------ corridors, gates, exterior

function hall(B, c, ctx) {
  const b = B.m;
  b.setAO(0.8, 1.5);
  corridorShell(b, c, {
    h: c.ceil, wall: C.wall, wainscot: C.wainscot, wainscotH: 1.15, ceil: c.ceil, ceilColor: C.ceiling, ceilGlow: 0.32,
    floorFn: (ix, iz) => ((ix + iz) % 2 ? C.tileA : C.tileB), cell: c.w / 6,
  });
  b.noAO();
  if (c.len > 2) {
    b.glow(1.2);
    b.box(c.x, c.ceil - 0.05, (c.zA + c.zB) / 2, 0.3, 0.05, Math.min(1.4, c.len * 0.4), C.panel);
    b.glow(0);
    ctx.lights.push({ x: c.x, y: c.ceil - 0.3, z: (c.zA + c.zB) / 2, color: lin(0xfff6e6), intensity: 0.3, range: 3.5 });
  }
}

function gateFrame(b, gate) {
  const room = gate.role === 'entry' ? 1 : -1; // room side along Z
  const hw = gate.w / 2;
  b.boxMM(gate.x - hw - 0.1, 0, gate.z - 0.17, gate.x - hw + 0.04, DOOR_H + 0.1, gate.z + 0.17, 0x9aa3a8);
  b.boxMM(gate.x + hw - 0.04, 0, gate.z - 0.17, gate.x + hw + 0.1, DOOR_H + 0.1, gate.z + 0.17, 0x9aa3a8);
  const z0 = gate.z + room * 0.0, z1 = gate.z + room * 0.38;
  b.boxMM(gate.x - hw - 0.15, DOOR_H - 0.02, Math.min(z0, z1), gate.x + hw + 0.15, DOOR_H + 0.42, Math.max(z0, z1), 0xb3bbbf);
  b.boxMM(gate.x - hw - 0.15, DOOR_H + 0.15, Math.min(z0, z1) - 0.01, gate.x + hw + 0.15, DOOR_H + 0.2, Math.max(z0, z1) + 0.01, 0x6fbfa6);
}

export function gate(g) {
  const leaf = new MeshBuilder();
  const w = g.w + 0.08, h = DOOR_H;
  const z = g.role === 'entry' ? 0.06 : -0.06;
  let k = 0;
  for (let y = -h; y < -0.001; y += 0.1, k++) leaf.box(0, y, z, w, 0.1, 0.045, k % 2 ? C.shutterA : C.shutterB, 0, { bottom: true });
  leaf.box(0, -h, z, w + 0.02, 0.09, 0.07, C.shutterBar, 0, { bottom: true });
  leaf.box(0, -h + 0.35, z + 0.04, 0.3, 0.04, 0.03, 0x5a6266, 0, { bottom: true });
  return { leaves: [{ builder: leaf, anim: 'roll', pivot: [0, h, 0] }], openTime: 0.85, closeTime: 0.55 };
}

function exterior(B, layout, ctx) {
  const { rng } = ctx;
  const b = B.m;
  const rooms = layout.areas.filter((a) => a.kind === 'room');
  const z0 = -14, z1 = layout.bounds.maxZ + 14;
  const line = Math.max(...rooms.map((a) => a.wall.maxX)) + 0.3;
  // ground everywhere (under the buildings too)
  b.quad(-40, z0 - 20, 70, z1 + 20, -0.02, 0x9b9e9c);
  // connector blocks between rooms (street facade fill)
  for (const c of layout.corridors) {
    if (c.from.kind !== 'room') continue;
    const x0 = c.x + c.w / 2 + 0.3, x1 = line;
    b.boxMM(x0, 0, c.zA, x1, Math.min(c.from.ceil, c.to.ceil) + 0.3, c.zB, 0xe8dcc6);
  }
  // building front: base strip + shop sign band along the street
  b.boxMM(line - 0.3, 0, layout.areas[1].zB - 0.3, line, 0.2, layout.bounds.maxZ + 0.3, 0x7fc2ab);
  // sidewalk, curb, road, far sidewalk
  const sx0 = line, sx1 = line + 3.4, rx1 = sx1 + 7.5, fx1 = rx1 + 3.2;
  b.floor(sx0, z0, sx1, z1, 0.06, 1.0, (ix, iz) => ((ix + iz) % 2 ? C.sidewalk : 0xd1ccc0));
  b.boxMM(sx1 - 0.2, 0, z0, sx1, 0.12, z1, C.curb);
  b.quad(sx1, z0, rx1, z1, 0.0, C.road);
  for (let z = z0; z < z1; z += 4) b.quad(sx1 + 3.65, z, sx1 + 3.85, z + 2, 0.005, C.lane);
  b.floor(rx1, z0, fx1, z1, 0.06, 1.0, (ix, iz) => ((ix + iz) % 2 ? C.sidewalk : 0xd1ccc0));
  // street trees + lamps on the near sidewalk
  for (let z = z0 + 4; z < z1; z += 9) {
    const tz = z + rng() * 2;
    b.cyl(sx1 - 0.8, 0, tz, 0.5, 0.08, 0x8b7a62, { seg: 8 });
    tree_(b, sx1 - 0.8, tz, 1.1, rng);
    b.cyl(rx1 + 0.5, 0, z + 4.5, 0.06, 4.2, 0x4d575c, { seg: 6 });
    b.box(rx1 + 0.25, 4.15, z + 4.5, 0.6, 0.12, 0.25, 0x4d575c);
  }
  // facades across the street
  let z = z0;
  let k = 0;
  while (z < z1) {
    const wdt = 6 + rng() * 4, h = 6.5 + rng() * 5.5, col = C.facades[k++ % C.facades.length];
    const x0 = fx1;
    b.boxMM(x0, 0, z, x0 + 8, h, z + wdt - 0.15, col);
    b.boxMM(x0 - 0.1, h, z - 0.05, x0 + 8, h + 0.3, z + wdt - 0.1, mix(col, 0xffffff, 0.35));
    // shopfront
    const shop = rng() < 0.7;
    if (shop) {
      b.boxMM(x0 - 0.02, 0.3, z + 0.6, x0, 2.6, z + wdt - 0.75, 0x5d7480);
      const aw = C.basket[k % C.basket.length];
      for (let s = 0; s < 6; s++) {
        const za = z + 0.5 + (wdt - 1.15) * (s / 6), zb = z + 0.5 + (wdt - 1.15) * ((s + 1) / 6);
        b.box(x0 - 0.55, 2.75, (za + zb) / 2, 1.1, 0.06, zb - za, s % 2 ? aw : 0xfbf8f1, 0, { rz: -0.35 });
      }
    }
    for (let y = 3.6; y < h - 1.2; y += 2.4) {
      for (let wz = z + 1.0; wz < z + wdt - 1.4; wz += 1.7) {
        b.boxMM(x0 - 0.05, y - 0.06, wz - 0.06, x0, y + 1.36, wz + 0.96, 0xfbf8f1);
        b.boxMM(x0 - 0.06, y, wz, x0 - 0.05, y + 1.3, wz + 0.9, rng() < 0.2 ? 0x8fa3b0 : 0x6f8796);
      }
    }
    z += wdt;
  }
  // distant rooftops behind the alley building
  for (let i = 0; i < 6; i++) b.boxMM(-30, 0, z0 + i * 16, -9, 9 + rng() * 6, z0 + i * 16 + 15, mix(0xd8cfc2, 0xbcd0dc, rng() * 0.5));
}

function tree_(b, x, z, s, rng) {
  b.cyl(x, 0, z, 0.1 * s, 2.4 * s, 0x6b5440, { rTop: 0.07 * s, seg: 6 });
  for (let i = 0; i < 5; i++) {
    const a = rng() * 6.28, r = rng() * 0.6 * s;
    b.blob(x + Math.cos(a) * r, (2.6 + rng() * 0.8) * s, z + Math.sin(a) * r, 0.75 * s, 0.6 * s, 0.75 * s, mix(0x7fb069, 0x4f8a55, rng()), 0, rng() * 3);
  }
}

export function build(ctx) {
  const { layout } = ctx;
  for (const a of layout.areas) {
    const B = ctx.B(a);
    if (a.kind === 'start') alley(B, a, ctx);
    else if (a.kind === 'corridor') hall(B, a, ctx);
    else { roomShell(B, a, ctx); dressRoom(B, a, ctx); }
  }
  for (const g of layout.gates) gateFrame(ctx.B(g.corridor).m, g);
  exterior(ctx.ext, layout, ctx);
}

export default { id: 'laundromat', light, build, gate };
