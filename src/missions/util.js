// Shared helpers for the MISSIONS module (pickups, shops, missions, save): formatting, plan access, ground probing,
// canvas textures, small DOM helpers. Node-safe: nothing touches document/window at import time.
import * as THREE from 'three';
import { WORLD } from '../core/config.js';

export const HAS_DOM = typeof document !== 'undefined';

/** '$1,234' (negative values get a leading minus). */
export function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

/** Race clock '1:02.34' (or '0:58.1' with digits = 1). */
export function fmtClock(sec, digits = 2) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const ss = r.toFixed(digits);
  return m + ':' + (r < 10 ? '0' : '') + ss;
}

/** '3:05' style countdown. */
export function fmtMinSec(sec) {
  const s = Math.max(0, Math.ceil(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 0xRRGGBB -> '#rrggbb'. */
export const hexCss = (n) => '#' + ((1 << 24) | ((n >>> 0) & 0xffffff)).toString(16).slice(1);
/** '#rrggbb' -> 0xRRGGBB. */
export const cssHex = (s) => parseInt(String(s).replace('#', '').slice(0, 6), 16) || 0;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** City plan or null. */
export function planOf(game) {
  return (game && game.generator && game.generator.plan) || null;
}

/** POIs of a type (works with partial plans). */
export function poisOfType(plan, type) {
  if (!plan) return [];
  try {
    if (typeof plan.poisOfType === 'function') return plan.poisOfType(type) || [];
    return (plan.pois || []).filter((p) => p.type === type);
  } catch (e) { return []; }
}

/** Run fn, swallow errors (cross-module calls into possibly-stubbed systems). */
export function safe(fn, fallback = undefined) {
  try { return fn(); } catch (e) { return fallback; }
}

/** Position the player effectively occupies (vehicle position while driving). */
export function playerPos(game) {
  const p = game && game.player;
  if (!p || !p.position) return null;
  const v = p.inVehicle;
  return v && v.position ? v.position : p.position;
}

/** Horizontal distance. */
export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/**
 * Standing height near (x, z), searching downward from hintY + up (so roofs/caves resolve to the floor closest to the
 * hint instead of the top of the column). Falls back to the plan surface / CITY_LEVEL.
 */
export function groundNear(game, x, z, hintY = null, up = 3) {
  const w = game && game.world;
  if (w && typeof w.isSolid === 'function') {
    try {
      const bx = Math.floor(x), bz = Math.floor(z);
      const start = Number.isFinite(hintY) ? Math.min(WORLD.HEIGHT - 2, Math.floor(hintY) + up) : WORLD.HEIGHT - 2;
      for (let y = start; y >= 1; y--) {
        if (w.isSolid(bx, y - 1, bz) && !w.isSolid(bx, y, bz) && !w.isSolid(bx, y + 1, bz)) return y;
      }
    } catch (e) { /* world stub */ }
  }
  const plan = planOf(game);
  if (plan && typeof plan.surfaceY === 'function') {
    const y = safe(() => plan.surfaceY(x, z), null);
    if (Number.isFinite(y)) return y;
  }
  return WORLD.CITY_LEVEL;
}

/** Deterministic PRNG (mulberry32). */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Canvas-backed texture (null outside the browser). draw(ctx, w, h). */
export function canvasTexture(w, h, draw) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Create a DOM element (class + text + parent). */
export function h(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** The #ui overlay root (created if missing). */
export function uiLayer() {
  let r = document.getElementById('ui');
  if (!r) {
    r = document.createElement('div');
    r.id = 'ui';
    r.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
    document.body.appendChild(r);
  }
  return r;
}

const _styles = new Set();
/** Inject a <style> once per id. */
export function injectCss(id, css) {
  if (!HAS_DOM || _styles.has(id)) return;
  _styles.add(id);
  const st = document.createElement('style');
  st.id = 'bcm-' + id;
  st.textContent = css;
  document.head.appendChild(st);
}

/** Escape text for innerHTML. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/** Notify through the HUD (no-op if HUD missing). */
export function notify(game, text, opts) {
  safe(() => game.hud && game.hud.notify && game.hud.notify(text, opts || {}));
}

/** Play a UI / world sound (no-op if audio missing). */
export function sound(game, name, opts) {
  safe(() => game.audio && game.audio.play && game.audio.play(name, opts || {}));
}

/** Set / clear the HUD GPS waypoint, preferring the HUD's setter. */
export function setWaypoint(game, wp) {
  const hud = game && game.hud;
  if (!hud) return;
  const v = wp && Number.isFinite(wp.x) && Number.isFinite(wp.z) ? { x: wp.x, z: wp.z } : null;
  if (typeof hud.setWaypoint === 'function') safe(() => hud.setWaypoint(v, false));
  else hud.waypoint = v;
}

/** District display name at (x, z) or ''. */
export function districtName(game, x, z) {
  const plan = planOf(game);
  if (!plan || typeof plan.districtAt !== 'function') return '';
  const d = safe(() => plan.districtAt(x, z), null);
  return (d && (d.name || d.id)) || '';
}
