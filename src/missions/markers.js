// World-space mission / shop markers (GTA-style): a glowing ground ring + translucent light column (additive, pulsing,
// slowly rotating) + a floating billboard icon. Also: floating chevrons above targets, voxel checkpoint arches for
// races, and glowing "force-field" fences that outline plots / condemned lots.
//
//   const mm = new MarkerManager(game);
//   const m = mm.marker({ x, y, z, color: '#f5c518', icon: 'letter', label: 'J' });
//   mm.update(dt);  // every frame (cheap: distance fade + a few sin() calls per marker)
//   mm.remove(m);
import * as THREE from 'three';
import { canvasTexture, HAS_DOM, cssHex } from './util.js';

export const MARKER_COLORS = {
  mission: '#f5c518',
  objective: '#f5c518',
  gunshop: '#e5484d',
  hardware: '#f59e0b',
  hospital: '#ffffff',
  garage: '#46c46f',
  safehouse: '#3fa9ff',
  target: '#ff3b30',
  vehicle: '#3fa9ff',
  package: '#8bd450',
  plot: '#46c46f',
  demolition: '#ff6a2a',
};

const ARCH_CY = 0.32;   // race arch centre height (x radius): the lower part of the ring is buried in the road
const VIS_NEAR = 110;   // full opacity inside this distance (m)
const VIS_FAR = 150;    // invisible beyond

// ------------------------------------------------------------------------------------------------ shared resources

let RES = null;
function res() {
  if (RES) return RES;
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);
  const colGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true);
  colGeo.translate(0, 0.5, 0);
  RES = {
    ringGeo,
    colGeo,
    ringTex: canvasTexture(128, 128, drawRing),
    colTex: canvasTexture(64, 128, drawColumn),
    glowTex: canvasTexture(64, 64, drawGlow),
    discGeo: (() => { const g = new THREE.CircleGeometry(1, 24); g.rotateX(-Math.PI / 2); return g; })(),
    icons: new Map(),
    chevronGeo: buildChevronGeometry(),
    archGeos: new Map(),
    arrowGeo: buildArrowGeometry(),
  };
  return RES;
}

function drawRing(g, w, h) {
  const cx = w / 2, cy = h / 2;
  // soft inner fill
  const fill = g.createRadialGradient(cx, cy, 0, cx, cy, 60);
  fill.addColorStop(0, 'rgba(255,255,255,0.10)');
  fill.addColorStop(0.75, 'rgba(255,255,255,0.22)');
  fill.addColorStop(0.9, 'rgba(255,255,255,0.0)');
  g.fillStyle = fill;
  g.beginPath(); g.arc(cx, cy, 60, 0, Math.PI * 2); g.fill();
  // bright outer ring with a soft halo
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 12;
  g.beginPath(); g.arc(cx, cy, 55, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 5;
  g.beginPath(); g.arc(cx, cy, 55, 0, Math.PI * 2); g.stroke();
  // inner dashed ring (makes the slow rotation readable)
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI * 2, a1 = a0 + Math.PI * 2 / 24;
    g.beginPath(); g.arc(cx, cy, 43, a0, a1); g.stroke();
  }
}

function drawColumn(g, w, h) {
  // bright at the bottom (canvas bottom = uv.y 0 = cylinder bottom), fading to nothing at the top
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // vertical light streaks
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 4; i++) {
    const x = (i / 4) * w + 4;
    const s = g.createLinearGradient(x, 0, x + 10, 0);
    s.addColorStop(0, 'rgba(255,255,255,0)');
    s.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.fillRect(x, 0, 10, h);
  }
  g.globalCompositeOperation = 'source-over';
}

function drawGlow(g, w, h) {
  const r = w / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

/** Downward-pointing voxel arrow (built from boxes) centred on the origin, tip at y = 0. */
function buildChevronGeometry() {
  const parts = [];
  const add = (w, hgt, d, x, y, z) => { const b = new THREE.BoxGeometry(w, hgt, d); b.translate(x, y, z); parts.push(b.toNonIndexed()); };
  const s = 0.16;
  // tip rows (wide at top, narrow at the bottom)
  add(s * 1, s, s * 1.4, 0, s * 0.5, 0);
  add(s * 3, s, s * 1.4, 0, s * 1.5, 0);
  add(s * 5, s, s * 1.4, 0, s * 2.5, 0);
  add(s * 7, s, s * 1.4, 0, s * 3.5, 0);
  // stem
  add(s * 2.6, s * 3.4, s * 1.4, 0, s * 5.7, 0);
  return mergeGeos(parts);
}

/** Vertical arrow in the XY plane (tip +Y) shown inside race checkpoints; rotated about Z to show the next turn. */
function buildArrowGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.6);
  shape.lineTo(1.3, 0.2);
  shape.lineTo(0.5, 0.2);
  shape.lineTo(0.5, -1.4);
  shape.lineTo(-0.5, -1.4);
  shape.lineTo(-0.5, 0.2);
  shape.lineTo(-1.3, 0.2);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false });
  g.translate(0, -0.1, -0.125);
  return g;
}

/** Merge non-indexed geometries (position + normal [+ color]). */
export function mergeGeos(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const hasCol = geos.every((g) => g.attributes.color);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = hasCol ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (col) col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

// ------------------------------------------------------------------------------------------------ icon billboards

/** Draw an icon glyph (white) centred at (0,0) with radius r. */
function drawGlyph(g, icon, r, label) {
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const s = r;
  switch (icon) {
    case 'cross': {
      g.fillStyle = '#e5484d';
      g.fillRect(-s * 0.22, -s * 0.72, s * 0.44, s * 1.44);
      g.fillRect(-s * 0.72, -s * 0.22, s * 1.44, s * 0.44);
      break;
    }
    case 'gun': {
      g.fillRect(-s * 0.75, -s * 0.38, s * 1.5, s * 0.36);
      g.fillRect(s * 0.55, -s * 0.5, s * 0.16, s * 0.14);
      g.beginPath();
      g.moveTo(-s * 0.72, -s * 0.05); g.lineTo(-s * 0.18, -s * 0.05); g.lineTo(-s * 0.3, s * 0.72); g.lineTo(-s * 0.78, s * 0.72);
      g.closePath(); g.fill();
      g.lineWidth = s * 0.1;
      g.beginPath(); g.arc(-s * 0.05, s * 0.08, s * 0.16, 0, Math.PI); g.stroke();
      break;
    }
    case 'cart': { // hardware: a block with a pickaxe-ish handle
      g.fillRect(-s * 0.62, -s * 0.15, s * 0.8, s * 0.8);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(-s * 0.62, -s * 0.15, s * 0.8, s * 0.2);
      g.fillStyle = '#fff';
      g.lineWidth = s * 0.14;
      g.beginPath(); g.moveTo(s * 0.05, s * 0.1); g.lineTo(s * 0.62, -s * 0.62); g.stroke();
      g.beginPath(); g.arc(s * 0.5, -s * 0.5, s * 0.42, Math.PI * 0.95, Math.PI * 1.55); g.stroke();
      break;
    }
    case 'spray': { // pay'n'spray: spray can
      g.fillRect(-s * 0.32, -s * 0.3, s * 0.64, s * 1.0);
      g.fillRect(-s * 0.16, -s * 0.52, s * 0.32, s * 0.24);
      g.beginPath(); g.arc(s * 0.42, -s * 0.62, s * 0.08, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(s * 0.62, -s * 0.48, s * 0.07, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(s * 0.56, -s * 0.78, s * 0.06, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'home': {
      g.beginPath();
      g.moveTo(0, -s * 0.78); g.lineTo(s * 0.8, -s * 0.05); g.lineTo(s * 0.55, -s * 0.05); g.lineTo(s * 0.55, s * 0.7);
      g.lineTo(-s * 0.55, s * 0.7); g.lineTo(-s * 0.55, -s * 0.05); g.lineTo(-s * 0.8, -s * 0.05); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(-s * 0.16, s * 0.2, s * 0.32, s * 0.5);
      break;
    }
    case 'check': {
      g.lineWidth = s * 0.24;
      g.beginPath(); g.moveTo(-s * 0.55, 0); g.lineTo(-s * 0.12, s * 0.45); g.lineTo(s * 0.6, -s * 0.45); g.stroke();
      break;
    }
    case 'dollar':
    case 'letter':
    default: {
      const t = icon === 'dollar' ? '$' : String(label || '!').charAt(0).toUpperCase();
      g.font = `900 ${Math.round(s * 1.35)}px Impact, "Arial Black", system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = s * 0.12;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.strokeText(t, 0, s * 0.06);
      g.fillText(t, 0, s * 0.06);
    }
  }
}

function iconTexture(icon, color, label, dim) {
  const r = res();
  const key = icon + '|' + color + '|' + (label || '') + '|' + (dim ? 1 : 0);
  if (r.icons.has(key)) return r.icons.get(key);
  const tex = canvasTexture(128, 128, (g, w) => {
    const c = w / 2;
    // drop shadow
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.arc(c + 3, c + 5, 50, 0, Math.PI * 2); g.fill();
    // badge
    const grad = g.createLinearGradient(0, c - 50, 0, c + 50);
    const base = dim ? '#8b8f99' : color;
    grad.addColorStop(0, lighten(base, 0.25));
    grad.addColorStop(1, darken(base, 0.18));
    g.fillStyle = grad;
    g.beginPath(); g.arc(c, c, 50, 0, Math.PI * 2); g.fill();
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(10,12,18,0.95)';
    g.stroke();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.arc(c, c, 44, Math.PI * 1.1, Math.PI * 1.75); g.stroke();
    g.save();
    g.translate(c, c);
    drawGlyph(g, icon, 38, label);
    g.restore();
  });
  r.icons.set(key, tex);
  return tex;
}

function lighten(hex, k) {
  const n = cssHex(hex);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function darken(hex, k) {
  const n = cssHex(hex);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(v * (1 - k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function fadeFor(d) {
  if (d <= VIS_NEAR) return 1;
  if (d >= VIS_FAR) return 0;
  const t = (d - VIS_NEAR) / (VIS_FAR - VIS_NEAR);
  return 1 - t * t * (3 - 2 * t);
}

function additiveMat(tex, color, opacity) {
  return new THREE.MeshBasicMaterial({
    map: tex || null, color: new THREE.Color(color), transparent: true, opacity, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false,
  });
}

// ------------------------------------------------------------------------------------------------ items

/** Ground ring + light column + billboard. opts: {x,y,z,color,icon,label,radius,height,column,sprite,range,dim}. */
export class Marker {
  constructor(opts = {}) {
    const R = res();
    this.kind = 'marker';
    this.color = opts.color || MARKER_COLORS.mission;
    this.radius = opts.radius || 1.25;
    this.height = opts.height || 3.6;
    this.range = opts.range || VIS_FAR;
    this.icon = opts.icon || null;
    this.label = opts.label || '';
    this.dim = !!opts.dim;
    this.active = false;      // player standing inside: brighter
    this.hidden = false;
    this.phase = Math.random() * 10;
    this.group = new THREE.Group();
    this.group.position.set(opts.x || 0, (opts.y || 0) + 0.04, opts.z || 0);
    this.ring = new THREE.Mesh(R.ringGeo, additiveMat(R.ringTex, this.color, 0.9));
    this.ring.renderOrder = 5;
    this.ring.scale.setScalar(this.radius);
    this.group.add(this.ring);
    this.column = null;
    if (opts.column !== false) {
      this.column = new THREE.Mesh(R.colGeo, additiveMat(R.colTex, this.color, 0.55));
      this.column.scale.set(this.radius * 0.92, this.height, this.radius * 0.92);
      this.column.renderOrder = 5;
      this.group.add(this.column);
    }
    this.sprite = null;
    if (opts.sprite !== false && this.icon && HAS_DOM) {
      const mat = new THREE.SpriteMaterial({ map: iconTexture(this.icon, this.color === '#ffffff' ? '#e8edf2' : this.color, this.label, this.dim), transparent: true, depthWrite: false, fog: false });
      this.sprite = new THREE.Sprite(mat);
      this.sprite.scale.setScalar(opts.iconSize || 1.15);
      this.sprite.position.y = this.height * 0.62 + 0.6;
      this.sprite.renderOrder = 6;
      this.group.add(this.sprite);
    }
    this._baseRing = 0.9;
    this._baseCol = 0.55;
  }

  get position() { return this.group.position; }

  setPosition(x, y, z) { this.group.position.set(x, y + 0.04, z); }

  setColor(color) {
    this.color = color;
    this.ring.material.color.set(color);
    if (this.column) this.column.material.color.set(color);
  }

  /** Muted look (completed mission givers). */
  setDim(dim) {
    dim = !!dim;
    if (dim === this.dim) return;
    this.dim = dim;
    if (this.sprite) this.sprite.material.map = iconTexture(this.icon, this.color, this.label, dim);
  }

  update(t, dt, cam) {
    const g = this.group;
    if (this.hidden) { g.visible = false; return; }
    const d = cam ? Math.hypot(cam.x - g.position.x, cam.z - g.position.z) : 0;
    const fade = d > this.range ? 0 : fadeFor(d * (VIS_FAR / this.range));
    g.visible = fade > 0.01;
    if (!g.visible) return;
    const tt = t + this.phase;
    const boost = this.active ? 1.35 : 1;
    const dimK = this.dim ? 0.45 : 1;
    const pulse = 0.82 + 0.18 * Math.sin(tt * 3.1);
    this.ring.material.opacity = this._baseRing * fade * pulse * boost * dimK;
    this.ring.rotation.y = tt * 0.45;
    const rs = this.radius * (1 + 0.05 * Math.sin(tt * 3.1) + (this.active ? 0.08 : 0));
    this.ring.scale.setScalar(rs);
    // standing in the marker: keep the view clear (dim the column, fade the badge near the camera)
    const camIn = this.active || d < this.radius + 1.5 ? 0.45 : 1;
    if (this.column) {
      this.column.material.opacity = this._baseCol * fade * (0.75 + 0.25 * Math.sin(tt * 2.2)) * dimK * camIn;
      this.column.rotation.y = -tt * 0.6;
    }
    if (this.sprite) {
      const sy = this.height * 0.62 + 0.6 + Math.sin(tt * 2) * 0.14;
      this.sprite.position.y = sy;
      const dc = cam ? Math.hypot(cam.x - g.position.x, cam.y - (g.position.y + sy), cam.z - g.position.z) : 10;
      const near = Math.max(0, Math.min(1, (dc - 3.5) / 4));
      this.sprite.material.opacity = Math.min(1, fade * 1.2) * near;
      this.sprite.visible = near > 0.01;
    }
  }

  dispose() {
    this.ring.material.dispose();
    if (this.column) this.column.material.dispose();
    if (this.sprite) this.sprite.material.dispose();
    this.group.removeFromParent();
  }
}

/** Floating, bobbing voxel arrow above a target. opts: {color, follow: () => {x,y,z}|null, offset (m above), scale}. */
export class Chevron {
  constructor(opts = {}) {
    const R = res();
    this.kind = 'chevron';
    this.follow = opts.follow || null;
    this.offset = opts.offset ?? 2.6;
    this.hidden = false;
    this.phase = Math.random() * 10;
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.color || MARKER_COLORS.target), transparent: true, opacity: 0.92, fog: false, depthWrite: true, toneMapped: false });
    this.mesh = new THREE.Mesh(R.chevronGeo, this.mat);
    this.mesh.scale.setScalar(opts.scale || 1);
    this.mesh.renderOrder = 6;
    this.glow = null;
    if (R.glowTex) {
      this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: R.glowTex, color: new THREE.Color(opts.color || MARKER_COLORS.target), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      this.glow.scale.setScalar(1.6 * (opts.scale || 1));
    }
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    if (this.glow) { this.glow.position.y = 0.5; this.group.add(this.glow); }
    if (opts.x !== undefined) this.group.position.set(opts.x, opts.y || 0, opts.z);
  }

  get position() { return this.group.position; }

  update(t, dt, cam) {
    const g = this.group;
    let p = null;
    if (this.follow) { try { p = this.follow(); } catch (e) { p = null; } }
    if (this.hidden || (this.follow && !p)) { g.visible = false; return; }
    const tt = t + this.phase;
    if (p) g.position.set(p.x, p.y + this.offset + Math.sin(tt * 3) * 0.18, p.z);
    const d = cam ? Math.hypot(cam.x - g.position.x, cam.z - g.position.z) : 0;
    g.visible = d < 260;
    this.mesh.rotation.y = tt * 1.8;
    // keep it readable from afar: grow slightly with distance
    const s = 1 + Math.min(2.2, Math.max(0, d - 25) / 45);
    g.scale.setScalar(s);
  }

  dispose() {
    this.mat.dispose();
    if (this.glow) this.glow.material.dispose();
    this.group.removeFromParent();
  }
}

/** Race checkpoint: a ring of glowing voxel cubes (an arch, lower part buried) + gate glow + direction arrow. */
export class Arch {
  constructor(opts = {}) {
    const R = res();
    this.kind = 'arch';
    this.radius = Math.max(3.5, opts.radius || 6);
    this.finish = !!opts.finish;
    this.state = 'next'; // 'next' | 'later' | 'hidden'
    this.hidden = false;
    this.phase = Math.random() * 10;
    const key = Math.round(this.radius * 2) / 2 + (this.finish ? 'f' : '');
    let geo = R.archGeos.get(key);
    if (!geo) { geo = buildArchGeometry(this.radius, this.finish); R.archGeos.set(key, geo); }
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, fog: false, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    // translucent gate disc
    this.gateMat = additiveMat(R.glowTex, opts.color || '#ffcc33', 0.22);
    this.gate = new THREE.Mesh(new THREE.CircleGeometry(this.radius - 0.4, 32), this.gateMat);
    this.gate.position.y = this.radius * ARCH_CY;
    this.group.add(this.gate);
    // direction arrow
    this.arrowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.arrowColor || '#ffe066'), transparent: true, opacity: 0.95, fog: false, toneMapped: false });
    this.arrow = new THREE.Mesh(R.arrowGeo, this.arrowMat);
    this.arrow.position.y = this.radius * ARCH_CY + 0.6;
    this.arrow.visible = !this.finish;
    this.group.add(this.arrow);
    this.group.position.set(opts.x || 0, (opts.y || 0) - 0.3, opts.z || 0);
    this.group.rotation.y = opts.yaw || 0;
    this.setNextDir(opts.nextYaw);
  }

  get position() { return this.group.position; }

  /**
   * Point the inner arrow toward the following checkpoint (world yaw of the next leg). Seen from behind (driving
   * along +Z local), local -X is the driver's right; turning right lowers yaw, so the arrow rolls by -relative yaw.
   */
  setNextDir(worldYaw) {
    if (!Number.isFinite(worldYaw)) { this.arrow.rotation.set(0, 0, 0); return; }
    let rel = worldYaw - this.group.rotation.y;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this.arrow.rotation.set(0, 0, -Math.max(-1.7, Math.min(1.7, rel)));
  }

  setState(state) { this.state = state; }

  update(t, dt, cam) {
    const g = this.group;
    if (this.hidden || this.state === 'hidden') { g.visible = false; return; }
    const d = cam ? Math.hypot(cam.x - g.position.x, cam.z - g.position.z) : 0;
    g.visible = d < 420;
    if (!g.visible) return;
    const tt = t + this.phase;
    const next = this.state === 'next';
    this.mat.opacity = next ? 0.95 : 0.35;
    this.gateMat.opacity = next ? 0.16 + 0.08 * Math.sin(tt * 4) : 0.05;
    this.arrow.visible = next && !this.finish;
    this.arrow.position.y = this.radius * ARCH_CY + 0.6 + Math.sin(tt * 3) * 0.2;
    const s = next ? 1 + 0.025 * Math.sin(tt * 5) : 0.9;
    this.mesh.scale.setScalar(s);
  }

  dispose() {
    this.mat.dispose();
    this.gateMat.dispose();
    this.arrowMat.dispose();
    this.gate.geometry.dispose();
    this.group.removeFromParent();
  }
}

function buildArchGeometry(radius, finish) {
  const parts = [];
  const n = Math.max(20, Math.round((Math.PI * 2 * radius) / 0.95));
  const c = new THREE.Color();
  const cy = radius * ARCH_CY;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * radius, y = cy + Math.sin(a) * radius;
    if (y < -0.6) continue; // buried part
    const b = new THREE.BoxGeometry(0.78, 0.78, 0.78).toNonIndexed();
    b.rotateZ(a);
    b.translate(x, y, 0);
    if (finish) c.set(i % 2 === 0 ? 0xffffff : 0x15161a);
    else c.set(i % 2 === 0 ? 0xffd23f : 0xff8a1f);
    const nrm = b.attributes.normal.array;
    const col = new Float32Array(b.attributes.position.count * 3);
    for (let k = 0; k < b.attributes.position.count; k++) {
      const shade = Math.abs(nrm[k * 3 + 2]) > 0.5 ? 1 : 0.78;
      col[k * 3] = c.r * shade; col[k * 3 + 1] = c.g * shade; col[k * 3 + 2] = c.b * shade;
    }
    b.setAttribute('color', new THREE.BufferAttribute(col, 3));
    b.deleteAttribute('uv');
    parts.push(b);
  }
  return mergeGeos(parts);
}

/** Glowing translucent fence around a rectangle: {x0,z0,x1,z1,y,height,color}. Walls + ground border + corner posts. */
export class Fence {
  constructor(opts = {}) {
    const R = res();
    this.kind = 'fence';
    this.hidden = false;
    this.phase = Math.random() * 10;
    const x0 = opts.x0, z0 = opts.z0, x1 = opts.x1, z1 = opts.z1;
    const hgt = opts.height || 3;
    const color = new THREE.Color(opts.color || MARKER_COLORS.plot);
    this.cx = (x0 + x1) / 2; this.cz = (z0 + z1) / 2;
    this.halfDiag = Math.hypot(x1 - x0, z1 - z0) / 2;
    // translucent gradient walls
    const pos = [], uv = [];
    const quad = (ax, az, bx, bz) => {
      pos.push(ax, 0, az, bx, 0, bz, bx, hgt, bz, ax, 0, az, bx, hgt, bz, ax, hgt, az);
      const L = Math.hypot(bx - ax, bz - az) / 4;
      uv.push(0, 0, L, 0, L, 1, 0, 0, L, 1, 0, 1);
    };
    quad(x0, z0, x1, z0); quad(x1, z0, x1, z1); quad(x1, z1, x0, z1); quad(x0, z1, x0, z0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const tex = R.colTex ? R.colTex.clone() : null;
    if (tex) { tex.wrapS = THREE.RepeatWrapping; tex.needsUpdate = true; }
    this.tex = tex;
    this.mat = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.55, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 5;
    // bright ground border (0.3 m strips just inside the rectangle) + corner posts
    const parts = [];
    const strip = (w, d, x, z) => { const b = new THREE.BoxGeometry(w, 0.06, d).toNonIndexed(); b.translate(x, 0.03, z); b.deleteAttribute('uv'); parts.push(b); };
    const W = x1 - x0, D = z1 - z0, t = 0.3;
    strip(W, t, this.cx, z0 + t / 2); strip(W, t, this.cx, z1 - t / 2);
    strip(t, D, x0 + t / 2, this.cz); strip(t, D, x1 - t / 2, this.cz);
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
      const b = new THREE.BoxGeometry(0.16, hgt * 1.25, 0.16).toNonIndexed();
      b.translate(x, hgt * 0.625, z);
      b.deleteAttribute('uv');
      parts.push(b);
    }
    this.lineMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, fog: false, toneMapped: false });
    this.lines = new THREE.Mesh(mergeGeos(parts), this.lineMat);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.lines);
    this.group.position.y = (opts.y || 0) + 0.02;
  }

  get position() { return this.group.position; }

  update(t, dt, cam) {
    const g = this.group;
    if (this.hidden) { g.visible = false; return; }
    const d = cam ? Math.max(0, Math.hypot(cam.x - this.cx, cam.z - this.cz) - this.halfDiag) : 0;
    g.visible = d < 220;
    if (!g.visible) return;
    const tt = t + this.phase;
    this.mat.opacity = 0.45 + 0.15 * Math.sin(tt * 2.4);
    if (this.tex) this.tex.offset.x = (tt * 0.12) % 1;
    this.lineMat.opacity = 0.7 + 0.25 * Math.sin(tt * 4);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.lines.geometry.dispose();
    this.mat.dispose();
    this.lineMat.dispose();
    if (this.tex) this.tex.dispose();
    this.group.removeFromParent();
  }
}

/** Soft additive glow sprite (shared texture). */
export function glowSprite(color, size = 1.4, opacity = 0.6) {
  const R = res();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: R.glowTex, color: new THREE.Color(color), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  sp.scale.setScalar(size);
  return sp;
}

/** Flat additive ground halo (shared geometry). */
export function groundHalo(color, radius = 0.7, opacity = 0.45) {
  const R = res();
  const m = new THREE.Mesh(R.discGeo, additiveMat(R.glowTex, color, opacity));
  m.scale.setScalar(radius);
  m.renderOrder = 4;
  return m;
}

// ------------------------------------------------------------------------------------------------ manager

export class MarkerManager {
  constructor(game) {
    this.game = game;
    this.items = new Set();
    this.t = 0;
    this._cam = new THREE.Vector3();
  }

  _add(item) {
    this.items.add(item);
    if (this.game && this.game.scene) this.game.scene.add(item.group);
    return item;
  }

  marker(opts) { return this._add(new Marker(opts)); }
  chevron(opts) { return this._add(new Chevron(opts)); }
  arch(opts) { return this._add(new Arch(opts)); }
  fence(opts) { return this._add(new Fence(opts)); }

  remove(item) {
    if (!item || !this.items.has(item)) return;
    this.items.delete(item);
    item.dispose();
  }

  clear() { for (const it of [...this.items]) this.remove(it); }

  /** Animate + distance-fade all items (call every frame, also while paused for a live look). */
  update(dt) {
    this.t += dt;
    const cam = this.game && this.game.camera ? this.game.camera.position : null;
    for (const it of this.items) it.update(this.t, dt, cam);
  }
}
