// Chapter layouts: a path of a start area, 3 fight rooms and a boss arena, joined by short corridors.
// Pure data + geometry (no THREE) so it can be unit-tested in node.
//
// Room.gate is the ENTRY gate (yaw 0 = direction of travel, +Z); Room.exitGate / Room.exit (a point inside the
// floor in front of it) describe the way onward; the boss arena has no exit.
// The path runs along +Z. Every area has a WALL rect (where walls / facades / railings stand) and a FLOOR rect
// (the open arena = wall rect inset by the prop band). Corridors run along Z between a room's +Z wall and the
// next room's -Z wall; their walkable strip reaches 1 m into both floors. Gates stand on the room walls:
// every room has an ENTRY gate (open by default) and, except the boss arena, an EXIT gate (closed by default).

/** Per-chapter dimensions (metres). w = width (X), d = depth (Z), x = centre X, band = prop band inside the walls. */
export const CHAPTER_LAYOUTS = {
  laundromat: {
    corridorW: 3, gateStyle: 'shutter', camMargin: 0.55, titleRoom: 1,
    start: { name: 'Back Alley', w: 6, d: 11, x: 0, band: 0.9, ceil: Infinity },
    corridors: [1.2, 4, 4, 4.5],
    rooms: [
      { name: 'Folding Room', w: 13, d: 12, x: 0, band: 1.5, ceil: 3.8 },
      { name: 'Wash Floor', w: 15, d: 13, x: 1.5, band: 1.5, ceil: 3.8 },
      { name: 'Dryer Hall', w: 13, d: 13, x: -0.5, band: 1.5, ceil: 3.8 },
      { name: 'Pressing Room', w: 16, d: 15, x: 0.5, band: 1.6, ceil: 4.4, boss: true },
    ],
  },
  market: {
    corridorW: 3.2, gateStyle: 'screens', camMargin: 0.35, titleRoom: 2,
    start: { name: 'Canal Gate', w: 8, d: 10, x: 0, band: 1.2, ceil: Infinity },
    corridors: [3, 4.5, 4.5, 5],
    rooms: [
      { name: 'Noodle Row', w: 14, d: 13, x: 0, band: 1.7, ceil: Infinity },
      { name: 'Canal Steps', w: 15, d: 13, x: -1.5, band: 1.7, ceil: Infinity, canal: true },
      { name: 'Lantern Court', w: 14, d: 14, x: 0.5, band: 1.7, ceil: Infinity },
      { name: 'Shu\'s Kitchen', shape: 'disc', r: 8.6, x: 0, band: 1.7, ceil: Infinity, boss: true },
    ],
  },
  gym: {
    corridorW: 3, gateStyle: 'doors', camMargin: 0.6, titleRoom: 0,
    start: { name: 'Front Desk', w: 9, d: 8, x: 0, band: 1.3, ceil: 3.6 },
    corridors: [3.5, 4, 4, 4.5],
    rooms: [
      { name: 'Bag Room', w: 14, d: 13, x: 0, band: 1.6, ceil: 5.4 },
      { name: 'Iron Floor', w: 15, d: 13, x: 1, band: 1.7, ceil: 5.4 },
      { name: 'Mat Hall', w: 14, d: 14, x: -1, band: 1.5, ceil: 5.4 },
      { name: 'The Pit', w: 17, d: 16, x: 0, band: 2.0, ceil: 6.6, boss: true },
    ],
  },
  tower: {
    corridorW: 3, gateStyle: 'glass', camMargin: 0.8, titleRoom: 1,
    start: { name: 'Sky Lobby', w: 8, d: 8, x: 0, band: 1.2, ceil: Infinity },
    corridors: [3, 5.5, 5.5, 6],
    rooms: [
      { name: 'Maple Terrace', w: 14, d: 13, x: 0, band: 1.8, ceil: Infinity },
      { name: 'Pool Garden', w: 15, d: 13, x: 1.5, band: 2.0, ceil: Infinity },
      { name: 'Stone Walk', w: 14, d: 14, x: -1, band: 1.8, ceil: Infinity },
      { name: 'Golden Pavilion', shape: 'disc', r: 9, x: 0, band: 2.0, ceil: Infinity, boss: true },
    ],
  },
};

export const CHAPTER_IDS = Object.keys(CHAPTER_LAYOUTS);
export const GATE_THICK = 0.3;
const CORRIDOR_REACH = 1.0; // how far a corridor's walkable strip reaches into a floor

const rect = (minX, maxX, minZ, maxZ) => ({ minX, maxX, minZ, maxZ });
const inset = (r, m) => rect(r.minX + m, r.maxX - m, r.minZ + m, r.maxZ - m);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Build the full layout for a chapter.
 * Returns { chapterId, playerStart, rooms, bounds, areas, corridors, gates, spec }.
 * `rooms` follow the FIGHTER.md Room contract; `areas` / `corridors` / `gates` are the internal model.
 */
export function buildLayout(chapterId) {
  const spec = CHAPTER_LAYOUTS[chapterId] || CHAPTER_LAYOUTS.laundromat;
  const id = CHAPTER_LAYOUTS[chapterId] ? chapterId : 'laundromat';
  const cw = spec.corridorW;
  const areas = [];
  const corridors = [];
  const gates = [];
  const rooms = [];

  // ---- start area
  const s = spec.start;
  let z = 0;
  const sWall = rect(s.x - s.w / 2, s.x + s.w / 2, z, z + s.d);
  const startArea = {
    kind: 'start', index: -1, name: s.name, shape: 'rect', wall: sWall, floor: inset(sWall, s.band), band: s.band,
    ceil: s.ceil, openings: { minZ: [], maxZ: [], minX: [], maxX: [] }, center: { x: s.x, z: z + s.d / 2 },
  };
  areas.push(startArea);
  z += s.d;

  let prev = startArea;
  spec.rooms.forEach((rs, i) => {
    const len = spec.corridors[i] ?? 4;
    const zA = z, zB = z + len;
    const disc = rs.shape === 'disc';
    const w = disc ? rs.r * 2 : rs.w, d = disc ? rs.r * 2 : rs.d;
    const wall = rect(rs.x - w / 2, rs.x + w / 2, zB, zB + d);
    const floor = inset(wall, rs.band);
    const area = {
      kind: 'room', index: i, name: rs.name, shape: disc ? 'disc' : 'rect', wall, floor, band: rs.band,
      ceil: rs.ceil, boss: !!rs.boss, canal: !!rs.canal, openings: { minZ: [], maxZ: [], minX: [], maxX: [] },
      center: { x: rs.x, z: zB + d / 2 },
      disc: disc ? { cx: rs.x, cz: zB + rs.r, rWall: rs.r, rFloor: rs.r - rs.band } : null,
    };
    // corridor X: inside both floors' X overlap
    let cx;
    if (disc) cx = rs.x;
    else {
      const lo = Math.max(prev.floor.minX, floor.minX) + cw / 2 + 0.2;
      const hi = Math.min(prev.floor.maxX, floor.maxX) - cw / 2 - 0.2;
      cx = Math.min(hi, Math.max(lo, (prev.center.x + rs.x) / 2));
    }
    // walkable strip of the corridor
    const prevFloorMaxZ = prev.disc ? prev.disc.cz + prev.disc.rFloor : prev.floor.maxZ;
    const nextFloorMinZ = disc ? area.disc.cz - area.disc.rFloor : floor.minZ;
    // where the corridor meets the disc wall (polygon approximated by the circle)
    const gateZB = disc ? area.disc.cz - Math.sqrt(Math.max(0, rs.r * rs.r - (cx - rs.x) ** 2)) : zB;
    const corr = {
      kind: 'corridor', index: i, name: `${prev.name} > ${rs.name}`, x: cx, w: cw, zA, zB: gateZB, len,
      walk: rect(cx - cw / 2, cx + cw / 2, prevFloorMaxZ - CORRIDOR_REACH, nextFloorMinZ + CORRIDOR_REACH),
      from: prev, to: area, gateA: null, gateB: null,
      ceil: (isFinite(prev.ceil) || isFinite(rs.ceil)) ? 3.2 : Infinity,
      center: { x: cx, z: (zA + gateZB) / 2 },
    };
    corr.wall = rect(cx - cw / 2, cx + cw / 2, zA, gateZB);
    corr.floor = corr.walk;
    corr.shape = 'rect';
    prev.openings.maxZ.push([cx - cw / 2, cx + cw / 2]);
    area.openings.minZ.push([cx - cw / 2, cx + cw / 2]);

    const roomId = 'r' + i;
    // entry gate of this room (on its -Z wall)
    const gEntry = { id: roomId + ':entry', roomId, role: 'entry', x: cx, z: gateZB, yaw: 0, w: cw, open: true, t: 1, blocking: false, corridor: corr, style: spec.gateStyle };
    corr.gateB = gEntry;
    gates.push(gEntry);
    // the previous room's exit gate sits on its +Z wall (start area has none)
    if (prev.kind === 'room') {
      const pr = rooms[prev.index];
      const gExit = { id: pr.id + ':exit', roomId: pr.id, role: 'exit', x: cx, z: zA, yaw: 0, w: cw, open: false, t: 0, blocking: true, corridor: corr, style: spec.gateStyle };
      corr.gateA = gExit;
      gates.push(gExit);
      pr.exitGate = { x: r2(cx), z: r2(zA), yaw: 0 };
      pr.exit = { x: r2(cx), z: r2(prev.floor.maxZ - 0.8) };
      pr.gates.push({ id: gExit.id, x: gExit.x, z: gExit.z, yaw: 0, role: 'exit' });
      pr._exitGate = gExit;
    }
    corridors.push(corr);
    areas.push(corr);
    areas.push(area);
    area.corridorIn = corr;
    if (prev.kind === 'room' || prev.kind === 'start') prev.corridorOut = corr;

    // ---- contract Room
    const cxr = area.center.x, czr = area.center.z;
    const hx = disc ? area.disc.rFloor : (floor.maxX - floor.minX) / 2;
    const hz = disc ? area.disc.rFloor : (floor.maxZ - floor.minZ) / 2;
    const radius = Math.min(hx, hz);
    const spawns = (rs.boss
      ? [[0, 0.5], [-0.55, 0.3], [0.55, 0.3], [0, 0.75], [-0.6, -0.05], [0.6, -0.05]]
      : [[0, 0.6], [-0.6, 0.45], [0.6, 0.45], [-0.3, 0.75], [0.3, 0.75], [-0.68, 0.05], [0.68, 0.05], [0, 0.25]])
      .map(([fx, fz]) => {
        let x = cxr + fx * (hx - 0.9), zz = czr + fz * (hz - 0.9);
        if (disc) { const k = Math.hypot(fx, fz); if (k > 0.8) { x = cxr + fx / k * 0.8 * (hx - 0.5); zz = czr + fz / k * 0.8 * (hz - 0.5); } }
        return { x: r2(x), z: r2(zz) };
      });
    const room = {
      id: roomId, index: i, kind: rs.boss ? 'boss' : 'fight', name: rs.name,
      center: { x: r2(cxr), z: r2(czr) }, radius: r2(radius), spawns,
      entry: { x: r2(cx), z: r2(nextFloorMinZ + 1.0) },
      gate: { x: r2(cx), z: r2(gateZB), yaw: 0 },   // the entry gate (closes behind the player)
      exitGate: null,                                 // fight rooms: the gate onward (opens on clear)
      gates: [{ id: gEntry.id, x: gEntry.x, z: gEntry.z, yaw: 0, role: 'entry' }],
      shape: disc ? 'disc' : 'rect', halfX: r2(hx), halfZ: r2(hz),
      rect: { minX: r2(cxr - hx), maxX: r2(cxr + hx), minZ: r2(czr - hz), maxZ: r2(czr + hz) },
      bossSpot: { x: r2(cxr), z: r2(czr + hz * 0.45) },
      exit: null,
    };
    Object.defineProperty(room, '_area', { value: area, enumerable: false });
    Object.defineProperty(room, '_entryGate', { value: gEntry, enumerable: false, writable: true });
    Object.defineProperty(room, '_exitGate', { value: null, enumerable: false, writable: true });
    area.room = room;
    rooms.push(room);
    z = zB + d;
    prev = area;
  });

  // bounds of everything walkable / built
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const a of areas) {
    b.minX = Math.min(b.minX, a.wall.minX); b.maxX = Math.max(b.maxX, a.wall.maxX);
    b.minZ = Math.min(b.minZ, a.wall.minZ); b.maxZ = Math.max(b.maxZ, a.wall.maxZ);
  }
  const playerStart = { x: s.x, z: r2(startArea.floor.minZ + Math.min(2.2, (startArea.floor.maxZ - startArea.floor.minZ) * 0.3)), yaw: 0 };
  return { chapterId: id, playerStart, rooms, bounds: b, areas, corridors, gates, spec };
}
