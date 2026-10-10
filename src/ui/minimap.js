// GTA-style radar (bottom-left): the pre-rendered city map rotating so the camera's view direction points up,
// zooming out with vehicle speed, blips from game.collectBlips() (shapes, icons, flashing, edge clamping,
// world-radius circles), the waypoint with a GPS route along the road graph, a north marker and the player arrow.
import { el } from './styles.js';
import {
  buildMapCanvas, drawBlip, drawAreaCircle, drawPlayerArrow, drawWaypoint, buildRoadGraph, computeRoute, WAYPOINT_COLOR,
} from './maprender.js';

export const RADAR_W = 236;
export const RADAR_H = 156;
const MAP_SCALE = 2;          // map canvas pixels per metre
const SEA = '#1d4f9c';
const EDGE = 9;               // edge-clamp margin (css px)
const FPS = 30;

/** Shared lazily-built resources (map image, road graph) for the radar and the full map. */
export class MapData {
  constructor(game) {
    this.game = game;
    this.canvas = null;
    this.graph = null;
    this._plan = null;
  }

  get plan() { return (this.game.generator && this.game.generator.plan) || null; }

  /** Build the map image once the plan exists. Returns true when ready. */
  ensure() {
    const plan = this.plan;
    if (this.canvas && plan === this._plan) return true;
    if (typeof document === 'undefined') return false;
    if (!plan && this.game.state === 'loading') return false;
    this._plan = plan;
    try { this.canvas = buildMapCanvas(plan, MAP_SCALE); } catch (e) { this.canvas = null; return false; }
    try { this.graph = buildRoadGraph(plan); } catch (e) { this.graph = null; }
    return true;
  }

  get scale() { return MAP_SCALE; }
}

/** View yaw of the camera (forward on x,z = (sin, cos)). Falls back to the camera rig yaw when looking straight down. */
export function cameraYaw(game, tmp) {
  const cam = game.camera;
  if (cam && cam.getWorldDirection && tmp) {
    cam.getWorldDirection(tmp);
    if (Math.hypot(tmp.x, tmp.z) > 0.04) return Math.atan2(tmp.x, tmp.z);
  }
  return (game.cameraRig && Number.isFinite(game.cameraRig.yaw)) ? game.cameraRig.yaw : 0;
}

export class Minimap {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.data = hud.mapData;
    this.wrap = null;
    this.frame = null;
    this.canvas = null;
    this.ctx = null;
    this.k = 1;            // backing pixels per css px
    this.mpp = 0.6;        // metres per css px (zoom)
    this._acc = 1;
    this._blips = [];
    this._dir = { x: 0, y: 0, z: 0 };
    this._alert = false;
    this.route = null;
    this._routeKey = '';
    this._routeT = 0;
    this._routeFrom = { x: 0, z: 0 };
    this._tmpV = null;
  }

  /** Create the radar DOM inside `parent`. */
  mount(parent) {
    this.wrap = el('div', 'bc-radar-wrap', parent);
    this.frame = el('div', 'bc-radar', this.wrap);
    this.canvas = el('canvas', '', this.frame);
    this.ctx = this.canvas.getContext('2d');
    return this.wrap;
  }

  /** Match the backing store to the on-screen size (HUD scale * devicePixelRatio). */
  resize(scale) {
    if (!this.canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.k = Math.max(0.5, scale * dpr);
    this.canvas.width = Math.round(RADAR_W * this.k);
    this.canvas.height = Math.round(RADAR_H * this.k);
    this._acc = 1;
  }

  /** Current GPS route (flat [x,z,...]) to hud.waypoint, recomputed when the waypoint changes or the player moves. */
  updateRoute(dt, px, pz) {
    const wp = this.hud.waypoint;
    if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.z)) { this.route = null; this._routeKey = ''; return; }
    const key = wp.x.toFixed(1) + ',' + wp.z.toFixed(1);
    this._routeT -= dt;
    const moved = Math.hypot(px - this._routeFrom.x, pz - this._routeFrom.z);
    if (key !== this._routeKey || (this._routeT <= 0 && moved > 6)) {
      this._routeKey = key;
      this._routeT = 1.0;
      this._routeFrom.x = px; this._routeFrom.z = pz;
      try { this.route = computeRoute(this.data.plan, this.data.graph, px, pz, wp.x, wp.z); } catch (e) { this.route = null; }
    }
  }

  update(dt, tmpV) {
    this._tmpV = tmpV;
    if (!this.ctx) return;
    const g = this.game;
    const p = g.player;
    const veh = p && p.inVehicle;
    // zoom: on foot close, vehicles zoom out with speed, helicopters further with altitude
    let target = 0.58;
    if (veh) {
      const sp = Math.abs(Number(veh.speed) || 0);
      target = 0.8 + Math.min(1, sp / 45) * 0.9;
      const kind = veh.def && veh.def.kind;
      if (kind === 'heli' || veh.kind === 'heli') {
        let ground = 28;
        try { ground = g.generator?.plan?.surfaceY?.(veh.position.x, veh.position.z) ?? 28; } catch (e) { ground = 28; }
        target = Math.max(target, 1.1 + Math.min(1.4, Math.max(0, veh.position.y - ground) / 60));
      }
    }
    if (g.state !== 'playing') target = 0.75;
    this.mpp += (target - this.mpp) * (1 - Math.exp(-2.2 * dt));

    const wanted = (g.police && g.police.wanted) | 0;
    const alert = wanted > 0;
    if (alert !== this._alert) { this._alert = alert; this.frame.classList.toggle('alert', alert); }

    const px = p && p.position ? p.position.x : 256, pz = p && p.position ? p.position.z : 256;
    this.updateRoute(dt, px, pz);

    this._acc += dt;
    if (this._acc < 1 / FPS) return;
    this._acc = 0;
    this.draw();
  }

  draw() {
    const g = this.game;
    const ctx = this.ctx;
    const k = this.k;
    const W = RADAR_W, H = RADAR_H;
    const p = g.player;
    const veh = p && p.inVehicle;
    const pos = veh && veh.position ? veh.position : (p && p.position);
    const px = pos ? pos.x : 256, pz = pos ? pos.z : 256;
    const yaw = cameraYaw(g, this._tmpV);
    const r = yaw + Math.PI;
    const cr = Math.cos(r), sr = Math.sin(r);
    const cx = W / 2, cy = H * 0.6;
    const inv = 1 / this.mpp;
    const t = g.realTime || 0;

    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, W, H);

    // map image
    const ready = this.data.ensure();
    const mc = this.data.canvas;
    if (ready && mc) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(r);
      ctx.scale(inv, inv);
      ctx.translate(-px, -pz);
      ctx.scale(1 / MAP_SCALE, 1 / MAP_SCALE);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(mc, 0, 0);
      ctx.restore();
    }
    // slight dark grade so blips pop
    ctx.fillStyle = 'rgba(6,10,18,0.16)';
    ctx.fillRect(0, 0, W, H);

    const toX = (wx, wz) => cx + ((wx - px) * cr - (wz - pz) * sr) * inv;
    const toY = (wx, wz) => cy + ((wx - px) * sr + (wz - pz) * cr) * inv;

    // GPS route
    const route = this.route;
    if (route && route.length >= 4) {
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(toX(px, pz), toY(px, pz));
      for (let i = 2; i < route.length; i += 2) ctx.lineTo(toX(route[i], route[i + 1]), toY(route[i], route[i + 1]));
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = WAYPOINT_COLOR; ctx.lineWidth = 3.4; ctx.stroke();
      ctx.restore();
    }

    // blips
    const blips = g.collectBlips ? g.collectBlips(this._blips) : this._blips;
    // radius circles first (under everything)
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (!b || !(b.radius > 0) || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      drawAreaCircle(ctx, b, toX(b.x, b.z), toY(b.x, b.z), b.radius * inv, t);
    }
    for (let i = 0; i < blips.length; i++) {
      const b = blips[i];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      if (b.radius > 0 && !b.shape && !b.icon) continue; // pure area blip
      let sx = toX(b.x, b.z), sy = toY(b.x, b.z);
      const inside = sx >= EDGE && sx <= W - EDGE && sy >= EDGE && sy <= H - EDGE;
      if (!inside) {
        if (!b.edge) continue;
        const c = this._clamp(sx, sy, cx, cy, W, H);
        sx = c.x; sy = c.y;
      }
      drawBlip(ctx, b, sx, sy, t, 1, !inside);
    }

    // waypoint
    const wp = this.hud.waypoint;
    if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) {
      let sx = toX(wp.x, wp.z), sy = toY(wp.x, wp.z);
      const inside = sx >= EDGE && sx <= W - EDGE && sy >= EDGE + 8 && sy <= H - EDGE;
      if (!inside) { const c = this._clamp(sx, sy, cx, cy, W, H, EDGE + 2); sx = c.x; sy = c.y + 6; }
      drawWaypoint(ctx, sx, sy, 1, !inside);
    }

    // north marker on the edge
    {
      const c = this._clamp(toX(px, pz - 10000), toY(px, pz - 10000), cx, cy, W, H, 11);
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.beginPath(); ctx.arc(c.x, c.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '800 10px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('N', c.x, c.y + 0.5);
      ctx.restore();
    }

    // player arrow: facing of the vehicle / body relative to the rotated map
    const face = veh && Number.isFinite(veh.yaw) ? veh.yaw : (p && Number.isFinite(p.yaw) ? p.yaw : yaw);
    const fx = Math.sin(face), fz = Math.cos(face);
    const ax = fx * cr - fz * sr, ay = fx * sr + fz * cr;
    const dead = p && p.alive === false;
    drawPlayerArrow(ctx, cx, cy, Math.atan2(ax, -ay), 7.5, dead ? '#8a8f98' : '#ffffff');
  }

  /** Clamp a radar point to the inner rectangle along the ray from the centre. */
  _clamp(sx, sy, cx, cy, W, H, m = EDGE) {
    const dx = sx - cx, dy = sy - cy;
    let tt = 1;
    if (dx > 0) tt = Math.min(tt, (W - m - cx) / dx); else if (dx < 0) tt = Math.min(tt, (m - cx) / dx);
    if (dy > 0) tt = Math.min(tt, (H - m - cy) / dy); else if (dy < 0) tt = Math.min(tt, (m - cy) / dy);
    tt = Math.max(0, tt);
    const c = this._c || (this._c = { x: 0, y: 0 });
    c.x = cx + dx * tt; c.y = cy + dy * tt;
    return c;
  }
}
