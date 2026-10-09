// Full-screen map (action `map`, M): the city image with pan (drag), zoom (wheel / pinch / buttons), POI icons with
// labels, district names, live blips, the player arrow, the GPS route and a legend. Click / tap sets the waypoint
// (hud.waypoint), right-click (or tapping the waypoint) clears it. Uses game.openUI('map'); closes with M / Esc.
import { el } from './styles.js';
import { drawBlip, drawPlayerArrow, drawWaypoint, drawAreaCircle, routeLength, WAYPOINT_COLOR, MAP_SIZE } from './maprender.js';
import { cameraYaw } from './minimap.js';
import { formatClock, titleCase } from './format.js';

/** POI type -> map look. */
export const POI_STYLE = {
  safehouse: { icon: 'home', color: '#43a047', name: 'Safehouse' },
  hospital: { icon: 'hospital', color: '#e53935', name: 'Hospital' },
  police: { icon: 'police', color: '#1e6fe0', name: 'Police Station' },
  gunshop: { icon: 'gun', color: '#ef6c00', name: 'Gun Shop' },
  hardware: { icon: 'shop', color: '#f9a825', name: 'Hardware Store' },
  garage: { icon: 'garage', color: '#00acc1', name: 'Pay \'n\' Spray' },
  mission: { icon: 'mission', color: '#f5c518', name: 'Mission' },
  helipad: { icon: 'mission', color: '#78909c', name: 'Helipad', letter: 'H' },
  mine: { icon: 'pickaxe', color: '#8d6e63', name: 'Mine' },
  beach: { icon: 'mission', color: '#26a69a', name: 'Beach', letter: 'B' },
};
const SEA = '#1d4f9c';
const MIN_Z = 0.6, MAX_Z = 9;

export class FullMap {
  constructor(hud) {
    this.hud = hud;
    this.game = hud.game;
    this.data = hud.mapData;
    this.root = null;
    this.isOpen = false;
    this.zoom = 2;          // css px per metre
    this.cx = 256; this.cz = 256; // world point at the screen centre
    this._ptrs = new Map();
    this._drag = null;
    this._pinch = null;
    this._dirty = true;
    this._acc = 0;
    this._blips = [];
    this._tmp = null;
    this._legendBuilt = false;
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    if (this.isOpen) return;
    const g = this.game;
    if (!this.data.ensure()) { g.hud?.notify?.('Map not ready yet'); return; }
    this.isOpen = true;
    g.openUI('map');
    g.audio?.play?.('ui_open');
    this._build();
    const p = g.player;
    const pos = p?.inVehicle?.position || p?.position;
    const W = this.root.clientWidth || window.innerWidth, H = this.root.clientHeight || window.innerHeight;
    const fit = Math.min(W, H) / MAP_SIZE * 0.92;
    this.zoom = Math.max(fit, Math.min(2.2, fit * 2.2));
    this.cx = pos ? pos.x : 256; this.cz = pos ? pos.z : 256;
    this._clampView();
    this._resize();
    this._dirty = true;
    this._updateWpInfo();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._ptrs.clear(); this._drag = null; this._pinch = null;
    if (this.root) { this.root.remove(); this.root = null; }
    this.game.closeUI('map');
  }

  _build() {
    const root = el('div', 'bc-map', this.hud.layerRoot);
    this.root = root;
    this.canvas = el('canvas', '', root);
    this.ctx = this.canvas.getContext('2d');
    const top = el('div', 'top', root);
    el('h2', '', top, 'MAP');
    this.whereEl = el('div', 'where', top);
    el('div', 'sp', top);
    const x = el('button', 'bc-x', top, '✕');
    x.title = 'Close (M / Esc)';
    x.addEventListener('click', (e) => { e.stopPropagation(); this.game.audio?.play?.('ui_click'); this.close(); });
    this.wpEl = el('div', 'wpinfo', root);
    this._buildLegend(root);
    const zoom = el('div', 'zoom', root);
    const zin = el('button', 'bc-btn small', zoom, '+');
    const zout = el('button', 'bc-btn small', zoom, '−');
    const zme = el('button', 'bc-btn small', zoom, '◎');
    zme.title = 'Centre on player';
    const stop = (e) => { e.stopPropagation(); };
    for (const b of [zin, zout, zme]) { b.addEventListener('pointerdown', stop); b.addEventListener('pointerup', stop); }
    zin.addEventListener('click', (e) => { e.stopPropagation(); this._zoomAt(1.35); });
    zout.addEventListener('click', (e) => { e.stopPropagation(); this._zoomAt(1 / 1.35); });
    zme.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = this.game.player; const pos = p?.inVehicle?.position || p?.position;
      if (pos) { this.cx = pos.x; this.cz = pos.z; this._clampView(); this._dirty = true; }
    });
    const touch = this.hud.touchMode;
    const foot = el('div', 'foot', root);
    const hints = touch
      ? ['Drag to pan', 'Pinch to zoom', 'Tap to set a waypoint', 'Tap the waypoint to clear it']
      : ['<kbd class="bc-key">Drag</kbd> pan', '<kbd class="bc-key">Wheel</kbd> zoom', '<kbd class="bc-key">LMB</kbd> set waypoint',
        '<kbd class="bc-key">RMB</kbd> clear waypoint', '<kbd class="bc-key">M</kbd> / <kbd class="bc-key">Esc</kbd> close'];
    for (const h of hints) el('span', '', foot).innerHTML = h;

    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      this._zoomAt(f, e.clientX, e.clientY);
    }, { passive: false });
    root.addEventListener('pointerdown', (e) => this._down(e));
    root.addEventListener('pointermove', (e) => this._move(e));
    root.addEventListener('pointerup', (e) => this._up(e));
    root.addEventListener('pointercancel', (e) => { this._ptrs.delete(e.pointerId); this._drag = null; this._pinch = null; root.classList.remove('drag'); });
    root.addEventListener('dblclick', (e) => this._zoomAt(1.6, e.clientX, e.clientY));
  }

  _buildLegend(root) {
    const lg = el('div', 'legend', root);
    const h = el('h4', '', lg, 'LEGEND ▾');
    h.addEventListener('click', (e) => { e.stopPropagation(); lg.classList.toggle('collapsed'); h.textContent = lg.classList.contains('collapsed') ? 'LEGEND ▸' : 'LEGEND ▾'; });
    lg.addEventListener('pointerdown', (e) => e.stopPropagation());
    lg.addEventListener('wheel', (e) => e.stopPropagation());
    if (window.innerWidth < 760 || window.innerHeight < 640) { lg.classList.add('collapsed'); h.textContent = 'LEGEND ▸'; }
    const plan = this.data.plan;
    const types = new Set((plan && plan.pois || []).map((p) => p.type));
    const add = (draw, label) => {
      const it = el('div', 'it', lg);
      const c = el('canvas', '', it);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = Math.round(22 * dpr);
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      draw(g);
      el('span', '', it, label);
    };
    add((g) => drawPlayerArrow(g, 11, 12, 0, 7.5), 'You');
    add((g) => drawWaypoint(g, 11, 18, 1), 'Waypoint');
    for (const [type, st] of Object.entries(POI_STYLE)) {
      if (!types.has(type)) continue;
      add((g) => drawBlip(g, { icon: st.icon, color: st.color, size: 7, label: st.letter || st.name }, 11, 11, 0, 1), st.name);
    }
    add((g) => drawBlip(g, { shape: 'dot', color: '#3d7bff', size: 6 }, 11, 11, 0, 1), 'Police');
    add((g) => { g.globalAlpha = 0.3; g.fillStyle = '#ff3b30'; g.beginPath(); g.arc(11, 11, 9, 0, 7); g.fill(); g.globalAlpha = 1; g.strokeStyle = '#ff3b30'; g.setLineDash([3, 2]); g.stroke(); }, 'Police search area');
  }

  /** POIs with a known style, most important first (labels are placed in this order). */
  _sortedPois(plan) {
    if (this._pois && this._poisPlan === plan) return this._pois;
    const order = ['safehouse', 'hospital', 'police', 'gunshop', 'hardware', 'garage', 'mission', 'helipad', 'mine', 'beach'];
    this._poisPlan = plan;
    this._pois = plan.pois.filter((p) => p && POI_STYLE[p.type] && Number.isFinite(p.x) && Number.isFinite(p.z))
      .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    return this._pois;
  }

  _resize() {
    if (!this.root) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.root.clientWidth || window.innerWidth, H = this.root.clientHeight || window.innerHeight;
    this.W = W; this.H = H; this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this._dirty = true;
  }

  onResize() { if (this.isOpen) { this._resize(); this._clampView(); } }

  // ---------------------------------------------------------------- interaction

  _screenToWorld(sx, sy) {
    const r = this.root.getBoundingClientRect();
    return { x: this.cx + (sx - r.left - this.W / 2) / this.zoom, z: this.cz + (sy - r.top - this.H / 2) / this.zoom };
  }

  _zoomAt(f, sx, sy) {
    const before = sx !== undefined ? this._screenToWorld(sx, sy) : null;
    const fit = Math.min(this.W || 800, this.H || 600) / MAP_SIZE * 0.9;
    this.zoom = Math.max(Math.min(MIN_Z, fit), Math.min(MAX_Z, this.zoom * f));
    if (before) {
      const after = this._screenToWorld(sx, sy);
      this.cx += before.x - after.x; this.cz += before.z - after.z;
    }
    this._clampView();
    this._dirty = true;
  }

  _clampView() {
    const W = this.W || window.innerWidth, H = this.H || window.innerHeight;
    const hw = W / 2 / this.zoom, hh = H / 2 / this.zoom;
    const pad = 40;
    this.cx = hw * 2 >= MAP_SIZE + pad * 2 ? MAP_SIZE / 2 : Math.max(hw - pad, Math.min(MAP_SIZE + pad - hw, this.cx));
    this.cz = hh * 2 >= MAP_SIZE + pad * 2 ? MAP_SIZE / 2 : Math.max(hh - pad, Math.min(MAP_SIZE + pad - hh, this.cz));
  }

  _down(e) {
    if (e.target.closest('button, .legend')) return;
    this._ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button });
    try { this.root.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (this._ptrs.size === 1) {
      this._drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: 0, button: e.button };
    } else if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.zoom };
      if (this._drag) this._drag.moved = 999;
    }
  }

  _move(e) {
    const pt = this._ptrs.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (this._pinch && this._ptrs.size >= 2) {
      const [a, b] = [...this._ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const target = this._pinch.zoom * (d / this._pinch.d);
      this._zoomAt(target / this.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dr = this._drag;
    if (!dr) return;
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    dr.moved = Math.max(dr.moved, Math.hypot(dx, dy));
    if (dr.moved > 4) {
      this.root.classList.add('drag');
      this.cx = dr.cx - dx / this.zoom;
      this.cz = dr.cz - dy / this.zoom;
      this._clampView();
      this._dirty = true;
    }
  }

  _up(e) {
    const had = this._ptrs.get(e.pointerId);
    this._ptrs.delete(e.pointerId);
    if (this._ptrs.size < 2) this._pinch = null;
    const dr = this._drag;
    if (this._ptrs.size === 0) { this._drag = null; this.root.classList.remove('drag'); }
    if (!had || !dr || dr.moved > 6) return;
    const w = this._screenToWorld(e.clientX, e.clientY);
    const g = this.game;
    const wp = this.hud.waypoint;
    const nearWp = wp && Math.hypot((wp.x - w.x) * this.zoom, (wp.z - w.z) * this.zoom) < 18;
    if (had.button === 2 || nearWp) {
      if (wp) { this.hud.setWaypoint(null); g.audio?.play?.('ui_click'); }
    } else if (had.button === 0 || had.button === -1 || had.button === undefined) {
      if (w.x < 0 || w.z < 0 || w.x >= MAP_SIZE || w.z >= MAP_SIZE) return;
      this.hud.setWaypoint({ x: w.x, z: w.z }, true);
      g.audio?.play?.('checkpoint', { volume: 0.5 });
    }
    this._updateWpInfo();
    this._dirty = true;
  }

  _updateWpInfo() {
    if (!this.wpEl) return;
    const wp = this.hud.waypoint;
    if (!wp) { this.wpEl.classList.remove('on'); return; }
    const route = this.hud.minimap && this.hud.minimap.route;
    let dist = route ? routeLength(route) : 0;
    if (!dist) {
      const p = this.game.player?.position;
      dist = p ? Math.hypot(wp.x - p.x, wp.z - p.z) : 0;
    }
    this.wpEl.textContent = 'Waypoint set · ' + (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m');
    this.wpEl.classList.add('on');
  }

  // ---------------------------------------------------------------- per frame

  update(dt, tmpV) {
    if (!this.isOpen || !this.root) return;
    this._tmp = tmpV;
    this._acc += dt;
    if (!this._dirty && this._acc < 0.1) return;
    this._acc = 0;
    this._dirty = false;
    this.draw();
    // header
    const g = this.game;
    const p = g.player?.position;
    let district = '';
    try { district = p && g.generator?.plan?.districtAt ? (g.generator.plan.districtAt(p.x, p.z)?.name || '') : ''; } catch (e) { district = ''; }
    const where = (district ? district + '  ·  ' : '') + (p ? Math.round(p.x) + ', ' + Math.round(p.z) : '') +
      (g.sky ? '  ·  ' + formatClock(g.sky.time) : '');
    if (where !== this._whereTxt) { this._whereTxt = where; this.whereEl.textContent = where; }
    if ((g.frame | 0) % 15 === 0) this._updateWpInfo();
  }

  draw() {
    const g = this.game;
    const ctx = this.ctx;
    const dpr = this.dpr || 1;
    const W = this.W, H = this.H;
    const z = this.zoom;
    const t = g.realTime || 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, W, H);
    const ox = W / 2 - this.cx * z, oy = H / 2 - this.cz * z;
    const sx = (wx) => ox + wx * z, sy = (wz) => oy + wz * z;
    const mc = this.data.canvas;
    if (mc) {
      ctx.imageSmoothingEnabled = z < 2;
      ctx.drawImage(mc, ox, oy, MAP_SIZE * z, MAP_SIZE * z);
      ctx.imageSmoothingEnabled = true;
    }
    // subtle block grid at high zoom (Minecraft feel)
    if (z >= 5) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor((0 - ox) / z)), x1 = Math.min(MAP_SIZE, Math.ceil((W - ox) / z));
      const z0 = Math.max(0, Math.floor((0 - oy) / z)), z1 = Math.min(MAP_SIZE, Math.ceil((H - oy) / z));
      for (let x = x0; x <= x1; x++) { ctx.moveTo(Math.round(sx(x)) + 0.5, sy(z0)); ctx.lineTo(Math.round(sx(x)) + 0.5, sy(z1)); }
      for (let q = z0; q <= z1; q++) { ctx.moveTo(sx(x0), Math.round(sy(q)) + 0.5); ctx.lineTo(sx(x1), Math.round(sy(q)) + 0.5); }
      ctx.stroke();
      ctx.restore();
    }
    const plan = this.data.plan;
    const placed = []; // label rects (centre x/y + half sizes) for collision-free labelling
    // district names
    if (plan && Array.isArray(plan.districts) && z < 4.5) {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(Math.max(11, Math.min(18, 7 * z)))}px system-ui, sans-serif`;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.fillStyle = 'rgba(255,255,255,.88)';
      const fs = Math.round(Math.max(11, Math.min(18, 7 * z)));
      for (const d of plan.districts) {
        if (!d || !Number.isFinite(d.x)) continue;
        const name = String(d.name || titleCase(d.id)).toUpperCase().split('').join('\u200A');
        const x = sx(d.x), y = sy(d.z);
        const hw = ctx.measureText(name).width / 2 + 4, hh = fs * 0.7;
        if (placed.some((r) => Math.abs(r.x - x) < r.hw + hw && Math.abs(r.y - y) < r.hh + hh)) continue;
        placed.push({ x, y, hw, hh });
        ctx.strokeText(name, x, y);
        ctx.fillText(name, x, y);
      }
      ctx.restore();
    }
    // route
    const route = this.hud.minimap && this.hud.minimap.route;
    if (route && route.length >= 4 && this.hud.waypoint) {
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx(route[0]), sy(route[1]));
      for (let i = 2; i < route.length; i += 2) ctx.lineTo(sx(route[i]), sy(route[i + 1]));
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = Math.max(5, 2.6 * z); ctx.stroke();
      ctx.strokeStyle = WAYPOINT_COLOR; ctx.lineWidth = Math.max(3, 1.5 * z); ctx.stroke();
      ctx.restore();
    }
    // dynamic blips (radius circles first)
    const blips = g.collectBlips ? g.collectBlips(this._blips) : [];
    for (const b of blips) {
      if (b && b.radius > 0 && Number.isFinite(b.x)) drawAreaCircle(ctx, b, sx(b.x), sy(b.z), b.radius * z, t);
    }
    // POIs
    const k = Math.max(1, Math.min(1.5, z / 2.2));
    const labels = z >= 1.6;
    if (plan && Array.isArray(plan.pois)) {
      const pois = this._sortedPois(plan);
      // icons for every POI, labels only where they do not collide (most important first)
      for (const poi of pois) {
        const st = POI_STYLE[poi.type];
        drawBlip(ctx, { icon: st.icon, color: st.color, size: 7, label: st.letter ? st.letter : (poi.name || st.name) }, sx(poi.x), sy(poi.z), t, k, false, false);
        placed.push({ x: sx(poi.x), y: sy(poi.z), hw: 10 * k, hh: 10 * k });
      }
      if (labels) {
        ctx.save();
        ctx.font = `700 ${Math.round(12 * k)}px system-ui, sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.fillStyle = '#fff';
        for (const poi of pois) {
          const label = poi.name || POI_STYLE[poi.type].name;
          const w = ctx.measureText(label).width;
          const x0 = sx(poi.x) + 13 * k, y0 = sy(poi.z);
          const r = { x: x0 + w / 2, y: y0, hw: w / 2 + 3, hh: 8 * k };
          if (placed.some((q) => Math.abs(q.x - r.x) < q.hw + r.hw && Math.abs(q.y - r.y) < q.hh + r.hh)) continue;
          placed.push(r);
          ctx.strokeText(label, x0, y0);
          ctx.fillText(label, x0, y0);
        }
        ctx.restore();
      }
    }
    for (const b of blips) {
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
      if (b.radius > 0 && !b.shape && !b.icon) continue;
      let x = sx(b.x), y = sy(b.z);
      const inside = x > 10 && y > 10 && x < W - 10 && y < H - 10;
      if (!inside) { if (!b.edge) continue; x = Math.max(14, Math.min(W - 14, x)); y = Math.max(14, Math.min(H - 14, y)); }
      drawBlip(ctx, b, x, y, t, k, !inside, labels && z >= 3);
    }
    // waypoint
    const wp = this.hud.waypoint;
    if (wp && Number.isFinite(wp.x)) drawWaypoint(ctx, sx(wp.x), sy(wp.z), 1.5);
    // player
    const p = g.player;
    if (p && p.position) {
      const veh = p.inVehicle;
      const pos = veh && veh.position ? veh.position : p.position;
      const face = veh && Number.isFinite(veh.yaw) ? veh.yaw : (Number.isFinite(p.yaw) ? p.yaw : cameraYaw(g, this._tmp));
      // map is north-up: facing (sin, cos) on (x, z) -> canvas angle atan2(fx, -fz)
      const a = Math.atan2(Math.sin(face), -Math.cos(face));
      const pulse = 1 + 0.12 * Math.sin(t * 6);
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(sx(pos.x), sy(pos.z), 15 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      drawPlayerArrow(ctx, sx(pos.x), sy(pos.z), a, 10);
    }
    // compass (above the zoom buttons)
    const cxp = 38, cyp = Math.max(110, H - 262);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.beginPath(); ctx.arc(cxp, cyp, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff5a4f';
    ctx.beginPath(); ctx.moveTo(cxp, cyp - 14); ctx.lineTo(cxp + 6, cyp); ctx.lineTo(cxp - 6, cyp); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cxp, cyp + 8);
    ctx.restore();
  }
}
