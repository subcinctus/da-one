// Shared map rendering for the radar (minimap.js) and the full-screen map (map.js): the pre-rendered city image,
// blip shapes + icon glyphs, the player arrow, and GPS routing over the plan's road graph (pure, Node-testable).

export const WAYPOINT_COLOR = '#e040fb';
export const MAP_SIZE = 512;

/**
 * Build the top-down map image once from plan.colorAt (512x512, 1 px = 1 m), upscaled `scale`x with nearest
 * neighbour so block edges stay crisp when the radar rotates it with smoothing on. Fallback: plain green land.
 */
export function buildMapCanvas(plan, scale = 2) {
  const base = document.createElement('canvas');
  base.width = base.height = MAP_SIZE;
  const g = base.getContext('2d');
  const img = g.createImageData(MAP_SIZE, MAP_SIZE);
  const d = img.data;
  const colorAt = plan && typeof plan.colorAt === 'function' ? plan.colorAt.bind(plan) : null;
  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      let c = 0x4f8a3a;
      if (colorAt) { try { c = colorAt(x, z) | 0; } catch (e) { c = 0x4f8a3a; } }
      const k = (z * MAP_SIZE + x) * 4;
      d[k] = (c >> 16) & 255; d[k + 1] = (c >> 8) & 255; d[k + 2] = c & 255; d[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  if (scale === 1) return base;
  const up = document.createElement('canvas');
  up.width = up.height = MAP_SIZE * scale;
  const ug = up.getContext('2d');
  ug.imageSmoothingEnabled = false;
  ug.drawImage(base, 0, 0, up.width, up.height);
  return up;
}

// ------------------------------------------------------------------ glyphs

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

function starPath(g, x, y, r, inner = 0.45, n = 5) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rad = i % 2 ? r * inner : r;
    if (i) g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); else g.moveTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  g.closePath();
}

/** Draw a white icon glyph centred at (x, y) within radius r. */
export function drawGlyph(g, icon, x, y, r, label) {
  const s = r * 0.62;
  g.save();
  g.translate(x, y);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.2, r * 0.16);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (icon) {
    case 'car':
      rr(g, -s, -s * 0.15, s * 2, s * 0.75, s * 0.2); g.fill();
      rr(g, -s * 0.55, -s * 0.62, s * 1.1, s * 0.6, s * 0.18); g.fill();
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.arc(-s * 0.55, s * 0.62, s * 0.24, 0, Math.PI * 2); g.arc(s * 0.55, s * 0.62, s * 0.24, 0, Math.PI * 2); g.fill();
      break;
    case 'gun':
      g.fillRect(-s, -s * 0.5, s * 1.9, s * 0.5);
      g.beginPath(); g.moveTo(-s * 0.95, -s * 0.05); g.lineTo(-s * 0.2, -s * 0.05); g.lineTo(-s * 0.35, s * 0.95); g.lineTo(-s * 1.0, s * 0.95); g.closePath(); g.fill();
      break;
    case 'cash':
    case 'mission': {
      const t = icon === 'cash' ? '$' : (label ? String(label).trim().charAt(0).toUpperCase() : '!');
      g.font = `900 ${Math.round(r * 1.25)}px Impact, "Arial Black", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t || '!', 0, r * 0.06);
      break;
    }
    case 'hospital':
      g.fillRect(-s * 0.3, -s, s * 0.6, s * 2); g.fillRect(-s, -s * 0.3, s * 2, s * 0.6);
      break;
    case 'police':
      starPath(g, 0, s * 0.05, s * 1.05, 0.48); g.fill();
      break;
    case 'shop':
      rr(g, -s * 0.8, -s * 0.35, s * 1.6, s * 1.35, s * 0.15); g.fill();
      g.beginPath(); g.arc(0, -s * 0.35, s * 0.45, Math.PI, 0); g.stroke();
      break;
    case 'home':
      g.beginPath(); g.moveTo(0, -s * 1.05); g.lineTo(s * 1.05, -s * 0.05); g.lineTo(s * 0.72, -s * 0.05); g.lineTo(s * 0.72, s * 0.95);
      g.lineTo(-s * 0.72, s * 0.95); g.lineTo(-s * 0.72, -s * 0.05); g.lineTo(-s * 1.05, -s * 0.05); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(-s * 0.2, s * 0.3, s * 0.4, s * 0.65);
      break;
    case 'pickaxe':
      g.beginPath(); g.moveTo(-s * 0.85, s * 0.95); g.lineTo(s * 0.45, -s * 0.35); g.stroke();
      g.lineWidth *= 1.5;
      g.beginPath(); g.arc(s * 0.35, -s * 0.25, s * 0.9, Math.PI * 1.02, Math.PI * 1.98); g.stroke();
      break;
    case 'garage':
      g.lineWidth *= 1.4;
      g.beginPath(); g.moveTo(-s * 0.8, s * 0.8); g.lineTo(s * 0.25, -s * 0.25); g.stroke();
      g.beginPath(); g.arc(s * 0.45, -s * 0.45, s * 0.5, Math.PI * 0.95, Math.PI * 2.55); g.stroke();
      break;
    default:
      g.beginPath(); g.arc(0, 0, s * 0.45, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/**
 * Draw one blip at canvas position (x, y). b = contract blip {color, shape, size, icon, flash, label}.
 * `t` = time (s) for flashing, `k` = UI scale, `clamped` = drawn on the radar edge (slightly smaller).
 */
export function drawBlip(g, b, x, y, t, k = 1, clamped = false, label = false) {
  if (b.flash && Math.floor(t * 2.6) % 2 === 1) return;
  const color = b.color || '#ffffff';
  const size = (Number(b.size) > 0 ? Number(b.size) : 6) * k * (clamped ? 0.85 : 1);
  g.save();
  g.lineWidth = Math.max(1.2, 1.6 * k);
  g.strokeStyle = 'rgba(0,0,0,.9)';
  g.fillStyle = color;
  if (b.icon) {
    const r = Math.max(6.5 * k, size + 1.5 * k);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    drawGlyph(g, b.icon, x, y, r, b.label);
  } else {
    switch (b.shape) {
      case 'square':
        g.fillRect(x - size * 0.7, y - size * 0.7, size * 1.4, size * 1.4);
        g.strokeRect(x - size * 0.7, y - size * 0.7, size * 1.4, size * 1.4);
        break;
      case 'triangle':
        g.beginPath(); g.moveTo(x, y - size); g.lineTo(x + size * 0.92, y + size * 0.68); g.lineTo(x - size * 0.92, y + size * 0.68); g.closePath();
        g.fill(); g.stroke();
        break;
      case 'star':
        starPath(g, x, y, size * 1.15, 0.46); g.fill(); g.stroke();
        break;
      case 'ring':
        g.lineWidth = Math.max(2, 2.6 * k);
        g.strokeStyle = 'rgba(0,0,0,.85)';
        g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.stroke();
        g.lineWidth = Math.max(1.2, 1.5 * k);
        g.strokeStyle = color;
        g.stroke();
        break;
      case 'arrow':
        g.beginPath(); g.moveTo(x, y - size * 1.1); g.lineTo(x + size * 0.85, y + size * 0.8); g.lineTo(x, y + size * 0.35);
        g.lineTo(x - size * 0.85, y + size * 0.8); g.closePath(); g.fill(); g.stroke();
        break;
      default: // dot
        g.beginPath(); g.arc(x, y, size * 0.72, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  if (label && b.label) {
    g.font = `700 ${Math.round(12 * k)}px system-ui, sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.lineWidth = 3 * k; g.strokeStyle = 'rgba(0,0,0,.85)';
    g.strokeText(b.label, x + size + 6 * k, y);
    g.fillStyle = '#fff';
    g.fillText(b.label, x + size + 6 * k, y);
  }
  g.restore();
}

function isReddish(hex) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(n)) return true;
  return ((n >> 16) & 255) >= (n & 255);
}

/** World-scaled area circle (police search area etc). r in canvas px. */
export function drawAreaCircle(g, b, x, y, r, t) {
  if (!(r > 1)) return;
  let color = b.color || '#ff3b30';
  if (b.flash && Math.floor(t * 2.2) % 2 === 1) color = isReddish(color) ? '#3d7bff' : '#ff3b30';
  g.save();
  g.globalAlpha = 0.2;
  g.fillStyle = color;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.85;
  g.lineWidth = 2;
  g.strokeStyle = color;
  g.setLineDash([6, 5]);
  g.stroke();
  g.restore();
}

/** Player arrow (GTA style) pointing along angle a (canvas radians, 0 = up), size in px. */
export function drawPlayerArrow(g, x, y, a, size, color = '#ffffff') {
  g.save();
  g.translate(x, y);
  g.rotate(a);
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.78, size * 0.82);
  g.lineTo(0, size * 0.42);
  g.lineTo(-size * 0.78, size * 0.82);
  g.closePath();
  g.lineWidth = Math.max(2, size * 0.22);
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,.92)';
  g.stroke();
  g.fillStyle = color;
  g.fill();
  g.restore();
}

/** Waypoint marker (magenta map pin). */
export function drawWaypoint(g, x, y, k = 1, clamped = false) {
  const r = (clamped ? 6 : 7.5) * k;
  g.save();
  g.fillStyle = WAYPOINT_COLOR;
  g.strokeStyle = 'rgba(0,0,0,.9)';
  g.lineWidth = 1.8 * k;
  g.beginPath();
  g.moveTo(x, y + r * 0.2);
  g.arc(x, y - r * 0.9, r, Math.PI * 0.8, Math.PI * 2.2);
  g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(x, y - r * 0.9, r * 0.38, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ GPS routing (pure)

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/** Road graph adjacency built once per plan: Map nodeId -> [{to, len}]. */
export function buildRoadGraph(plan) {
  const nodes = new Map();
  const adj = new Map();
  if (!plan || !Array.isArray(plan.nodes) || !Array.isArray(plan.roads)) return { nodes, adj };
  for (const n of plan.nodes) { if (n) { nodes.set(n.id, n); adj.set(n.id, []); } }
  for (const r of plan.roads) {
    if (!r) continue;
    const a = nodes.get(r.a), b = nodes.get(r.b);
    if (!a || !b) continue;
    const len = Math.hypot(a.x - b.x, a.z - b.z);
    adj.get(a.id).push({ to: b.id, len });
    adj.get(b.id).push({ to: a.id, len });
  }
  return { nodes, adj };
}

function entryNodes(plan, graph, x, z) {
  const out = [];
  let road = null;
  try { road = plan.roadAt ? plan.roadAt(x, z) : null; } catch (e) { road = null; }
  if (road && graph.nodes.has(road.a) && graph.nodes.has(road.b)) {
    for (const id of [road.a, road.b]) { const n = graph.nodes.get(id); out.push({ id, cost: Math.hypot(n.x - x, n.z - z) }); }
    return out;
  }
  let n = null;
  try { n = plan.nearestNode ? plan.nearestNode(x, z) : null; } catch (e) { n = null; }
  if (!n) {
    let bd = Infinity;
    for (const m of graph.nodes.values()) { const d = Math.hypot(m.x - x, m.z - z); if (d < bd) { bd = d; n = m; } }
  }
  if (n && graph.nodes.has(n.id)) out.push({ id: n.id, cost: Math.hypot(n.x - x, n.z - z) * 1.3 });
  return out;
}

/**
 * Shortest road route from (x0,z0) to (x1,z1): flat array [x,z, x,z, ...] starting at the start point and ending at
 * the target. Returns null when no graph is available. Short hops (< 40 m) route straight.
 */
export function computeRoute(plan, graph, x0, z0, x1, z1) {
  if (!graph || !graph.nodes.size) return null;
  if (Math.hypot(x1 - x0, z1 - z0) < 40) return [x0, z0, x1, z1];
  const starts = entryNodes(plan, graph, x0, z0);
  const ends = entryNodes(plan, graph, x1, z1);
  if (!starts.length || !ends.length) return null;
  const endCost = new Map();
  for (const e of ends) endCost.set(e.id, Math.min(endCost.get(e.id) ?? Infinity, e.cost));
  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  const h = (id) => { const n = graph.nodes.get(id); return Math.hypot(n.x - x1, n.z - z1); };
  for (const s of starts) {
    if (s.cost < (dist.get(s.id) ?? Infinity)) { dist.set(s.id, s.cost); prev.set(s.id, -1); heap.push(s.cost + h(s.id), s.id); }
  }
  let best = Infinity, bestId = null;
  let guard = 0;
  while (heap.size && guard++ < 20000) {
    const id = heap.pop();
    const d = dist.get(id);
    if (d + h(id) >= best) break;
    if (endCost.has(id)) { const tot = d + endCost.get(id); if (tot < best) { best = tot; bestId = id; } }
    for (const e of graph.adj.get(id) || []) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, id); heap.push(nd + h(e.to), e.to); }
    }
  }
  if (bestId === null) return [x0, z0, x1, z1];
  const ids = [];
  for (let id = bestId; id !== -1 && id !== undefined; id = prev.get(id)) ids.push(id);
  ids.reverse();
  const pts = [x0, z0];
  for (const id of ids) { const n = graph.nodes.get(id); pts.push(n.x, n.z); }
  pts.push(x1, z1);
  return pts;
}

/** Length of a flat route array in metres. */
export function routeLength(pts) {
  let L = 0;
  if (!pts) return 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return L;
}
