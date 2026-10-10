// Settings and Controls pages shared by the title screen and the pause menu.
import { el } from './styles.js';
import { DEFAULT_SETTINGS } from '../core/config.js';

const SLIDERS = [
  { key: 'renderDistance', label: 'Render distance', desc: 'Chunks loaded around you', min: 4, max: 12, step: 1, fmt: (v) => v + ' ch', live: false },
  { key: 'fov', label: 'Field of view', min: 55, max: 100, step: 1, fmt: (v) => v + '°', live: true },
  { key: 'mouseSensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + '×', live: true },
  { key: 'volume', label: 'Master volume', min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', live: true },
  { key: 'musicVolume', label: 'Radio volume', min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', live: true },
];
const TOGGLES = [
  { key: 'invertY', label: 'Invert mouse Y' },
  { key: 'shadows', label: 'Shadows', desc: 'Sharper look, costs performance' },
  { key: 'autoJump', label: 'Auto-jump', desc: 'Step up single blocks automatically' },
  { key: 'showFPS', label: 'Show FPS counter' },
];
const PIXEL_RATIOS = [0.5, 0.75, 1, 1.25, 1.5];

/** Settings page element. onBack() is called by the Back button. */
export function buildSettingsPage(game, onBack) {
  const page = el('div', 'bc-page');
  const head = el('header', '', page);
  el('h2', '', head, 'Settings');
  const x = el('button', 'bc-x', head, '✕');
  x.addEventListener('click', () => { click(game); onBack(); });
  const body = el('div', 'body bc-scroll', page);
  const s = game.settings || {};
  let saveTimer = 0;
  const save = (now) => {
    clearTimeout(saveTimer);
    const run = () => { try { game.saveSettings(); } catch (e) { console.error('[menus] saveSettings', e); } };
    if (now) run(); else saveTimer = setTimeout(run, 120);
  };
  const refreshers = [];

  for (const def of SLIDERS) {
    const row = el('div', 'bc-set', body);
    const lab = el('label', '', row, def.label);
    if (def.desc) el('span', 'd', lab, def.desc);
    const inp = el('input', '', row);
    inp.type = 'range';
    inp.min = def.min; inp.max = def.max; inp.step = def.step;
    const val = el('span', 'val', row);
    const paint = () => {
      const v = Number(s[def.key] ?? DEFAULT_SETTINGS[def.key]);
      inp.value = String(v);
      val.textContent = def.fmt(v);
      inp.style.setProperty('--p', (((v - def.min) / (def.max - def.min)) * 100).toFixed(1) + '%');
    };
    paint();
    refreshers.push(paint);
    inp.addEventListener('input', () => {
      const v = def.step >= 1 ? Math.round(Number(inp.value)) : Number(inp.value);
      s[def.key] = v;
      val.textContent = def.fmt(v);
      inp.style.setProperty('--p', (((v - def.min) / (def.max - def.min)) * 100).toFixed(1) + '%');
      if (def.live) save(false);
    });
    inp.addEventListener('change', () => save(true));
  }

  for (const def of TOGGLES) {
    const row = el('div', 'bc-set', body);
    const lab = el('label', '', row, def.label);
    if (def.desc) el('span', 'd', lab, def.desc);
    const sw = el('button', 'bc-sw', row);
    sw.setAttribute('aria-label', def.label);
    const paint = () => sw.classList.toggle('on', !!s[def.key]);
    paint();
    refreshers.push(paint);
    sw.addEventListener('click', () => { s[def.key] = !s[def.key]; paint(); click(game); save(true); });
  }

  {
    const row = el('div', 'bc-set', body);
    const lab = el('label', '', row, 'Resolution scale');
    el('span', 'd', lab, 'Lower = faster');
    const seg = el('div', 'bc-seg', row);
    const btns = PIXEL_RATIOS.map((r) => {
      const b = el('button', '', seg, r === 1 ? '1×' : r + '×');
      b.addEventListener('click', () => { s.pixelRatio = r; paint(); click(game); save(true); });
      return b;
    });
    const paint = () => {
      const cur = Number(s.pixelRatio) || 1;
      let best = 0;
      PIXEL_RATIOS.forEach((r, i) => { if (Math.abs(r - cur) < Math.abs(PIXEL_RATIOS[best] - cur)) best = i; });
      btns.forEach((b, i) => b.classList.toggle('on', i === best));
    };
    paint();
    refreshers.push(paint);
  }

  const foot = el('footer', '', page);
  const reset = el('button', 'bc-btn small', foot, 'Reset defaults');
  reset.addEventListener('click', () => {
    Object.assign(s, DEFAULT_SETTINGS);
    refreshers.forEach((f) => f());
    click(game);
    save(true);
  });
  const back = el('button', 'bc-btn small primary', foot, 'Back');
  back.addEventListener('click', () => { click(game); onBack(); });
  return page;
}

const k = (...keys) => keys.map((x) => `<kbd class="bc-key">${x}</kbd>`).join(' ');
const CONTROLS = [
  ['On foot', [
    ['Move', k('W', 'A', 'S', 'D')], ['Look', 'Mouse'], ['Sprint', k('Shift')], ['Jump / swim up', k('Space')],
    ['Sneak / dive (in water)', k('X') + ' or ' + k('Z')], ['Hands up (surrender)', 'Hold ' + k('B')],
    ['Camera (1st / 3rd / far)', k('C') + ' or ' + k('V')],
    ['Enter / steal vehicle', k('F')], ['Shoot / punch', k('LMB')], ['Aim', k('RMB')], ['Reload', k('R')],
    ['Throw grenade', k('G')], ['Next weapon', k('Q')], ['Select hotbar slot', k('1') + ' … ' + k('9') + ' or wheel'],
  ]],
  ['Building', [
    ['Mine block (hold)', k('LMB')], ['Place block', k('RMB')], ['Pick block (creative)', k('MMB')],
    ['Fly (creative)', 'Double-tap ' + k('Space')], ['Fly up / down (creative)', k('Space') + ' / ' + k('Shift')],
    ['Fly fast (creative)', k('X')], ['Inventory / creative palette', k('E')],
  ]],
  ['Driving', [
    ['Accelerate / brake & reverse', k('W') + ' / ' + k('S')], ['Steer', k('A') + ' / ' + k('D')], ['Handbrake (drift)', k('Space')],
    ['Horn (police car: siren)', k('H')], ['Headlights', k('L')], ['Next radio station', k('N')], ['Exit vehicle', k('F')],
    ['Look around', 'Mouse'], ['Drive-by: aim / shoot', k('RMB') + ' + ' + k('LMB')],
  ]],
  ['Flying (helicopter)', [
    ['Ascend / descend', k('Space') + ' / ' + k('Shift')], ['Pitch forward / back', k('W') + ' / ' + k('S')], ['Turn', k('A') + ' / ' + k('D')],
  ]],
  ['Menus', [
    ['Pause', k('Esc') + ' or ' + k('P')], ['Map', k('M')], ['Inventory', k('E')], ['Mission log', k('J')], ['Close panel', k('Esc')],
  ]],
];

/** Controls page element. */
export function buildControlsPage(game, onBack, touch = false) {
  const page = el('div', 'bc-page');
  const head = el('header', '', page);
  el('h2', '', head, 'Controls');
  const x = el('button', 'bc-x', head, '✕');
  x.addEventListener('click', () => { click(game); onBack(); });
  const body = el('div', 'body bc-scroll bc-ctl', page);
  if (touch) {
    el('h3', '', body, 'Touch');
    const t = el('table', '', body);
    t.innerHTML = [
      ['Move', 'Left thumb stick (push fully to run)'], ['Look', 'Drag on the right side'], ['Shoot / mine', 'ATK button (hold)'],
      ['Aim / place block', 'AIM button'], ['Enter vehicle', 'F button'], ['Hotbar', 'Tap a slot'],
    ].map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  }
  for (const [title, rows] of CONTROLS) {
    el('h3', '', body, title);
    const t = el('table', '', body);
    t.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  }
  const note = el('div', 'note', body);
  note.textContent = 'Tip: lose the cops by breaking line of sight until the stars stop flashing, or pay for a respray at the garage.';
  const foot = el('footer', '', page);
  const back = el('button', 'bc-btn small primary', foot, 'Back');
  back.addEventListener('click', () => { click(game); onBack(); });
  return page;
}

function click(game) { game.audio?.play?.('ui_click'); }
