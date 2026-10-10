# Block City

A free-roam open-world game that runs in your browser. It mixes the open-world crime sandbox (steal cars, cause chaos, outrun the cops, take on jobs for cash) with a voxel sandbox (mine and place blocks, dig for ore, build anything, blow things up with TNT).

Everything is generated in code: the city, the terrain, every texture, every vehicle and character model, all sound effects and the radio music. There are no image or audio files. The whole game ships as **one self-contained HTML file**.

## Play

- **Easiest:** open `dist/index.html` in Chrome, Edge or Firefox on a desktop or laptop. It works offline with a double-click; no install or server needed.
- Click **Play**. The mouse is captured for looking around; press **Esc** to get it back and open the pause menu.
- Progress (money, inventory, completed missions and every block you placed or destroyed) autosaves in your browser. **Continue** and **New Game** appear on the title screen once a save exists.
- On a phone or tablet, on-screen touch controls appear automatically. Keyboard and mouse is the intended way to play.

## What's in it

**The city and beyond**
- A 512 × 512 block map: downtown skyscrapers, mid-rise districts, brick old town, suburbs, an industrial port, a central park with a pond, and a beach with palms and a pier.
- Countryside outside the city: hills, forests, a snow-capped mountain range, and a mine full of ore.
- A ring road with tunnels and bridges circles the city and connects the countryside.
- A full day and night cycle. Lit windows, street lamps and neon light up after dark. Rain and thunderstorms roll in from time to time.

**Driving**
- 14 vehicles: sedan, taxi, sports car, supercar, muscle car, pickup, van, truck, bus, motorbike, police cruiser, SWAT van, and two helicopters you can fly.
- Arcade handling with handbrake drifts, crash damage, smoke and fire, and explosions.
- Steal any car with **F**. If someone is driving, you drag them out.
- 4 radio stations of generated music: synthwave, boom-bap, chiptune and lo-fi.

**Building and mining**
- Mine any block with the pickaxe, axe, shovel or your bare hands; harder blocks take longer.
- Place blocks from your hotbar. **E** opens a 36-slot inventory.
- Ore (coal, iron, gold, diamond) pays cash when you mine it.
- Creative mode gives unlimited blocks and flight.

**Combat and chaos**
- Weapons: fists, bat, pistol, SMG, pump shotgun, assault rifle, scoped sniper rifle, rocket launcher and grenades.
- Explosions carve real craters in the world. TNT chains set each other off.
- Pedestrians panic, flee or fight back. The gang in the port district shoots back.

**Police**
- Crimes earn wanted stars, from 1 to 5. More stars bring more patrol cars, officers on foot, a helicopter with a searchlight, SWAT and roadblocks.
- Break line of sight to lose them. A search area shows on the radar until they give up.
- Get caught on foot and you're **BUSTED**. Die and you're **WASTED**.

**Missions, shops and economy**
- 8 missions:
  - **Joyride**: steal a supercar.
  - **Checkpoint Race**.
  - **Package Run** across the rooftops.
  - **Demolition Contract**: bring down a building with TNT and rockets.
  - **Diamond Rush**: mine ore in the mine.
  - **Hit**: take out a gang leader.
  - **Builder**: build a structure.
  - **Taxi**: a side job.
- Shops:
  - **Gun shop**: weapons and ammo.
  - **Hardware store**: blocks, TNT and tools.
  - **Hospital**: healing.
  - **Pay 'n' Spray**: repair, respray and clear your wanted level.
  - **Safehouse**: save and sleep until morning.
- GTA-style HUD: rotating radar with GPS route, money, wanted stars, ammo, and a Minecraft-style hotbar. **M** opens the full map with waypoints; **J** opens the mission log.

## Controls

| On foot | |
|---|---|
| Move / look | W A S D / mouse |
| Sprint, jump / swim up, sneak | Shift, Space, X |
| Hands up (surrender) | B (hold) |
| Camera: 1st / 3rd / far person | C |
| Enter or steal a vehicle | F |
| Shoot or punch / aim | Left mouse / right mouse |
| Reload, throw grenade, next weapon | R, G, Q |
| Hotbar slot | 1 to 9, or the mouse wheel |

| Building | |
|---|---|
| Mine a block (hold) | Left mouse |
| Place a block | Right mouse |
| Pick block (creative) | Middle mouse |
| Fly (creative mode) | Double-tap Space |
| Inventory and creative palette | E |

| Driving | |
|---|---|
| Accelerate / brake and reverse | W / S |
| Steer | A / D |
| Handbrake (drift) | Space |
| Horn (police car: siren), headlights, next radio station | H, L, N |
| Drive-by: aim and shoot | Right mouse + left mouse |
| Exit | F |

| Helicopter | |
|---|---|
| Up / down | Space / Shift |
| Forward / back | W / S |
| Turn | A / D |

| Menus | |
|---|---|
| Pause | Esc or P |
| Map | M |
| Inventory | E |
| Mission log | J |

## Tips

- Yellow markers on the radar are jobs. Walk into one to start it.
- Ore pays: dig down in the mountains or head into the mine.
- Hit a red TNT block with a bullet to light it. Stand back.
- With cops on your tail, get out of their sight and stay hidden until the stars stop flashing. The Pay 'n' Spray also clears your wanted level, for a fee.
- Settings (view distance, mouse sensitivity, field of view, volume, shadows) are in the pause menu. Lower the view distance if the game runs slowly.

## For developers

```
npm install           # three.js, esbuild, playwright (dev only)
npm run build         # dist/index.html: minified, self-contained, the shippable game
npm run build:dev     # dist/dev.html: unminified with source maps
npm run check         # syntax-check every file + bundle (catches bad imports/exports)
npm run smoke -- --tag me --scenario tools/scenarios/playtest.mjs   # headless play-test (Chromium + SwiftShader)
```

- **Stack:** three.js r160 + plain ES modules, bundled by esbuild into a single HTML file (`tools/build.mjs`). No runtime dependencies, no network.
- **Architecture:** `ARCHITECTURE.md` is the module contract. It covers coordinate conventions, the game loop and system lifecycle, the event catalogue, input actions, the entity registry, voxel physics, the city-plan format, and every module's public API.
- **Layout of `src/`:**

| Path | What it does |
|---|---|
| `core/` | Game loop, input actions, events, entity registry, voxel physics, noise |
| `world/` | Block registry, procedural texture atlas, chunk mesher, streaming world, city and terrain generator, sky |
| `player/` | On-foot controller, camera rig, inventory, mining and building |
| `vehicles/` | Vehicle types, models and arcade physics |
| `ai/` | Traffic, pedestrians, police |
| `combat/` | Weapons, ballistics, explosions, TNT, projectiles |
| `fx/`, `audio/` | Particles; synthesised sound effects, engines, sirens, radio |
| `ui/` | HUD, minimap, map, inventory screen, menus, touch controls |
| `missions/` | Missions, pickups, shops, save system |

- **Testing:** `tools/smoke.mjs` boots the real game headless and exposes `window.game` to scenario scripts. `gameWait()` and `hold()` measure in simulated time, so tests stay reliable on slow software rendering. Every module also registers `game.debug.*` helpers, such as `spawnCar`, `setWanted`, `giveWeapons`, `startMission` and `setTime`.
