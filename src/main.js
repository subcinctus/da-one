// Entry point: constructs every system in a fixed order, initialises them with a loading screen, starts the loop.
// Owned by core. Module agents: do not edit - request changes via your report.
import { Game } from './core/game.js';
import { Generator } from './world/generator.js';
import { World } from './world/world.js';
import { Sky } from './world/sky.js';
import { FX } from './fx/fx.js';
import { AudioSystem } from './audio/audio.js';
import { Combat } from './combat/combat.js';
import { Inventory } from './player/inventory.js';
import { Player } from './player/player.js';
import { CameraRig } from './player/camera.js';
import { Vehicles } from './vehicles/vehicles.js';
import { Traffic } from './ai/traffic.js';
import { Peds } from './ai/peds.js';
import { Police } from './ai/police.js';
import { Pickups } from './missions/pickups.js';
import { Shops } from './missions/shops.js';
import { Missions } from './missions/missions.js';
import { SaveSystem } from './missions/save.js';
import { HUD } from './ui/hud.js';
import { Menus } from './ui/menus.js';
import { TouchControls } from './ui/touch.js';

async function main() {
  const container = document.getElementById('game');
  const game = new Game(container);
  window.game = game;

  // Registration order == per-frame update order.
  game.addSystem('generator', new Generator(game, game.seed));
  game.addSystem('sky', new Sky(game));
  game.addSystem('world', new World(game));
  game.addSystem('inventory', new Inventory(game));
  game.addSystem('player', new Player(game));
  game.addSystem('vehicles', new Vehicles(game));
  game.addSystem('traffic', new Traffic(game));
  game.addSystem('peds', new Peds(game));
  game.addSystem('police', new Police(game));
  game.addSystem('combat', new Combat(game));
  game.addSystem('pickups', new Pickups(game));
  game.addSystem('shops', new Shops(game));
  game.addSystem('missions', new Missions(game));
  game.addSystem('cameraRig', new CameraRig(game));
  game.addSystem('fx', new FX(game));
  game.addSystem('audio', new AudioSystem(game));
  game.addSystem('hud', new HUD(game));
  game.addSystem('menus', new Menus(game));
  game.addSystem('touch', new TouchControls(game));
  game.addSystem('save', new SaveSystem(game));

  // Init order (dependencies first). HUD first so the loading screen exists.
  const initOrder = ['hud', 'menus', 'touch', 'audio', 'generator', 'world', 'sky', 'fx', 'combat', 'inventory', 'player',
    'cameraRig', 'vehicles', 'traffic', 'peds', 'police', 'pickups', 'shops', 'missions', 'save'];
  const setLoading = (p, text) => { try { game.hud.setLoading(p, text); } catch (e) { /* hud broken */ } };
  game.start(); // render loop runs during loading (paused simulation) so the loading screen animates

  for (let i = 0; i < initOrder.length; i++) {
    const name = initOrder[i];
    const sys = game.sys[name];
    const base = i / initOrder.length;
    setLoading(base, `Loading ${name}...`);
    await new Promise((r) => setTimeout(r, 0)); // let the browser paint
    try {
      if (sys.init) {
        await sys.init((p, text) => setLoading(base + (Math.max(0, Math.min(1, p)) / initOrder.length), text || `Loading ${name}...`));
      }
    } catch (e) {
      console.error(`[${name}] init error:`, e);
    }
    sys.__inited = true; // even after a failed init, so a partially working system can still run
  }
  setLoading(1, 'Ready');
  try { game.hud.hideLoading(); } catch (e) { /* ignore */ }

  game.state = 'title';
  // Ask before closing / reloading the tab while playing (an accidental Ctrl+W or F5 would silently lose progress
  // since the last autosave). Automated browsers (tools/smoke.mjs, soak harness) reload pages freely.
  window.addEventListener('beforeunload', (e) => {
    if (game.state !== 'playing' || navigator.webdriver) return;
    e.preventDefault();
    e.returnValue = '';
  });
  game.events.emit('ready', {});
  if (game.params.get('autostart')) {
    game.startPlaying();
  } else {
    try { game.menus.showTitle(); } catch (e) { console.error('[menus] showTitle', e); game.startPlaying(); }
  }
}

main().catch((e) => {
  console.error('Fatal startup error', e);
  const el = document.getElementById('fatal');
  if (el) { el.style.display = 'block'; el.textContent = 'Startup error: ' + (e && e.message ? e.message : e); }
});
