// Entry point: constructs systems in a fixed order, initialises them with a loading screen, starts the loop.
// Owned by core. Module agents: do not edit; request changes in your report.
import { Game } from './core/game.js';
import { AnimLibrary } from './anim/library.js';
import { World } from './world/world.js';
import { CameraRig } from './camera/camera.js';
import { FX } from './fx/fx.js';
import { AudioSystem } from './audio/audio.js';
import { Combat } from './combat/combat.js';
import { AI } from './ai/ai.js';
import { Encounters } from './levels/encounters.js';
import { Flow } from './game/flow.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';

async function main() {
  const game = new Game(document.getElementById('game'));
  window.game = game;

  // Registration order == per-step fixedUpdate order and per-frame update order.
  game.addSystem('flow', new Flow(game));
  game.addSystem('ai', new AI(game));
  game.addSystem('combat', new Combat(game));
  game.addSystem('encounters', new Encounters(game));
  game.addSystem('world', new World(game));
  game.addSystem('cameraRig', new CameraRig(game));
  game.addSystem('fx', new FX(game));
  game.addSystem('audio', new AudioSystem(game));
  game.addSystem('hud', new HUD(game));
  game.addSystem('menus', new Menus(game));
  game.addSystem('anim', new AnimLibrary(game));

  const initOrder = ['hud', 'menus', 'audio', 'anim', 'world', 'fx', 'cameraRig', 'combat', 'ai', 'encounters', 'flow'];
  const setLoading = (p, text) => { try { game.hud.setLoading(p, text); } catch (e) { /* hud broken */ } };
  game.start();
  for (let i = 0; i < initOrder.length; i++) {
    const name = initOrder[i], sys = game.sys[name], base = i / initOrder.length;
    setLoading(base, `Loading ${name}...`);
    await new Promise((r) => setTimeout(r, 0));
    try {
      if (sys.init) await sys.init((p, text) => setLoading(base + Math.max(0, Math.min(1, p)) / initOrder.length, text));
    } catch (e) { console.error(`[${name}] init error:`, e); }
    sys.__inited = true;
  }
  setLoading(1, 'Ready');
  try { game.hud.hideLoading(); } catch (e) { /* ignore */ }
  game.state = 'title';
  game.events.emit('ready', {});
  try {
    if (game.params.get('autostart')) await game.flow.quickStart();
    else game.flow.showTitle();
  } catch (e) { console.error('[flow] start', e); }
}

main().catch((e) => {
  console.error('Fatal startup error', e);
  const el = document.getElementById('fatal');
  if (el) { el.style.display = 'block'; el.textContent = 'Startup error: ' + (e && e.message ? e.message : e); }
});
