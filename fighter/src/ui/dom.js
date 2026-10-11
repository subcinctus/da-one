// Small DOM helpers shared by the HUD and menus.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape a value. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Create an element with a class and optional innerHTML. */
export function h(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  return e;
}

/** Roman numerals for chapter numbers. */
export const roman = (n) => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n);

/** Play a UI sound if the audio system is up. */
export function sfx(game, name, opts) {
  try { if (game && game.audio && typeof game.audio.play === 'function') game.audio.play(name, opts); } catch (e) { /* audio optional */ }
}

/** The #ui root (created if the page lacks it). */
export function uiRoot() {
  let r = document.getElementById('ui');
  if (!r) { r = h('div'); r.id = 'ui'; document.body.appendChild(r); }
  return r;
}

/** Stance diamond icon (small inline SVG); `lit` fills it. */
export function stanceIcon(stance, lit = false, cls = 'ls-sticon') {
  const pos = { FL: [6, 6], FR: [18, 6], BL: [6, 18], BR: [18, 18] };
  let s = `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">`;
  for (const k of ['FL', 'FR', 'BL', 'BR']) {
    const [x, y] = pos[k];
    const on = k === stance;
    s += `<rect x="${x - 3.6}" y="${y - 3.6}" width="7.2" height="7.2" transform="rotate(45 ${x} ${y})" ` +
      `fill="${on && lit ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${on ? 1.6 : 1}" opacity="${on ? 1 : 0.4}"/>`;
  }
  return s + '</svg>';
}

/** "FR → BR" with tiny stance icons. */
export function stanceArrow(from, to) {
  return `<span class="ls-arrow">${stanceIcon(from, true)}<b>${esc(from)}</b><i>→</i>${stanceIcon(to, true)}<b>${esc(to)}</b></span>`;
}
