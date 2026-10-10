# BLOCK CITY: Architecture & Module Contract

Block City is a browser free-roam game that mixes the open-world crime sandbox genre (GTA V style: driving, stealing cars, traffic, pedestrians, guns, wanted stars, police chases, missions, money, minimap, radio) with a voxel sandbox (Minecraft style: a block world you can mine and build in, procedural terrain, ores, TNT, pixel-art textures, blocky characters).

Everything is procedural: there are no image or sound assets. Textures are drawn on canvases and sounds are synthesised with WebAudio. The build produces ONE self-contained HTML file (`dist/index.html`) with three.js inlined, playable by double-click and offline.

This document is the **contract** between modules. If you are a module agent, read §0 (rules), §1–§4 (conventions and core APIs), your own module section in §5, and the sections of any module you call.

---

## 0. Rules for module agents

1. **File ownership is strict.** Edit only the files you own (§6). You may create new helper files only inside your own directory/prefix. Never edit core files (`src/main.js`, `src/core/*`, `src/world/blocks.js`, `src/entities/humanoid.js`, `src/index.html`, `tools/*`, this doc). If you need a core change, list it under `coreRequests` in your final report. Work around it in your own module in the meantime.
2. **Implement the public API in §5 exactly**: class name, file, method names, argument order, return shapes. Other agents are coding against it right now, in parallel, without seeing your code. You may add methods. Do not rename or remove contracted ones.
3. **Defensive integration.** Other modules may still be stubs or have bugs. Use optional chaining when calling across modules (`this.game.hud?.notify?.(...)`), and never let your module throw because another returned `null`. Constructors must not touch other systems; do cross-system wiring in `init()` or lazily.
4. **No new npm dependencies.** Use only `three` (r160, `import * as THREE from 'three'`; addons via `three/examples/jsm/...` are allowed) and browser APIs. No network requests and no external assets. Everything runs from a `file://` URL.
5. **Performance budget** (mid-range laptop, 60 fps target): keep your per-frame `update()` under ~1.5 ms typical. Avoid per-frame allocations in hot loops (reuse `THREE.Vector3` temporaries). Share geometries/materials. Dispose geometries you discard. Prefer few draw calls (merge, InstancedMesh, vertex colours).
6. **Style.** Use modern ES modules, 2-space indentation, single quotes, semicolons, and short doc comments on public methods. Keep `console.log` quiet in steady state. `console.error` is reserved for real errors because the smoke test fails on it.
7. **UI CSS**: any DOM UI injects its own `<style>` from JS. There are no CSS files. Mount under `document.getElementById('ui')` (pointer-events: none by default; set `pointer-events: auto` on interactive panels). Use the CSS variables defined in `src/index.html` (`--accent`, `--panel`, `--font-display`, ...).
8. **Do not commit to git.** The orchestrator handles version control.
9. Validate with `npm run check` (syntax + bundle), unit-test pure logic with `node`, and boot the real game with `npm run smoke` (§7). Other agents are editing their files at the same time, so a failure in a file you do not own may be transient. Do not "fix" it. Mention it in your report.

---

## 1. Coordinates & conventions

- **Units:** 1 block = 1 metre. Y is up. The world spans x ∈ [0, 512), z ∈ [0, 512), y ∈ [0, 96).
- **Block (x,y,z)** occupies [x,x+1) × [y,y+1) × [z,z+1). Its centre is (x+0.5, y+0.5, z+0.5).
- **Standing height**: an entity standing on top of block y has `position.y = y + 1`. City streets: `WORLD.CITY_LEVEL = 28` (road blocks at y=27). Sea surface: `WORLD.SEA_LEVEL = 24` (water at y ≤ 23).
- **Entity position** is the **bottom-centre** (feet / wheels contact).
- **Yaw θ**: forward = (sin θ, 0, cos θ). θ=0 faces +Z. right = (−cos θ, 0, sin θ). **Turning right decreases θ.** Pitch φ > 0 looks up. Helpers live in `core/math.js` (`forwardFromYaw`, `rightFromYaw`, `dirFromYawPitch`, `yawTo`, `wrapAngle`, `angleDiff`, `damp`). Models are built facing +Z, so `obj.rotation.y = θ`.
- **Traffic drives on the RIGHT.** For a road traversed in direction d = (dx, dz) (unit), the right-hand normal is r = (−dz, dx). Lane i (0 = innermost) centre offset = `(i + 0.5) * road.width / (2 * road.lanes)` along r from the road centre line.
- **Chunks**: 16 × 96 × 16. Chunk (cx, cz) covers x ∈ [16cx, 16cx+16). Voxel index inside chunk data: `voxelIndex(lx, y, lz) = lx + lz*16 + y*256` (from `core/config.js`).
- **Time**: `game.time` = simulated seconds (frozen while paused). `dt` is clamped to ≤ 0.05.

## 2. Game object & lifecycle (`src/core/game.js`, `src/main.js`)

`main.js` constructs every system as `new X(game)` and registers it with `game.addSystem(name, sys)`, which also sets `game[name]`. Names: `generator, sky, world, inventory, player, vehicles, traffic, peds, police, combat, pickups, shops, missions, cameraRig, fx, audio, hud, menus, touch, save`.

**Update order** (each frame, in this order): generator (no update), sky, world, inventory, player, vehicles, traffic, peds, police, combat, pickups, shops, missions, cameraRig, fx, audio, hud, menus, touch, save. Then every system's `lateUpdate(dt)` runs in the same order, then the frame renders.

**Init order** (`await sys.init(onProgress)`): hud, menus, touch, audio, generator, world, sky, fx, combat, inventory, player, cameraRig, vehicles, traffic, peds, police, pickups, shops, missions, save. `onProgress(p0to1, text)` updates the loading bar. Init may be async. A throwing init is logged and the game continues.

**System interface** (all optional):

- `init(onProgress)`
- `update(dt)`
- `lateUpdate(dt)`
- `getBlips(out)`: push minimap blips (§4.6)
- `onResize(w, h)`
- `runWhenPaused = true`: `update` still runs while paused or while a UI panel is open (HUD, menus, touch, audio)

**State:**

- `game.state`: `'loading' | 'title' | 'playing'`
- `game.paused`: pause menu or title screen is up
- `game.uiOpen`: some panel (inventory, shop, map...) is open
- `game.running`: true when state is playing, not paused, and no UI is open. Simulation systems only update when `running`.
- `game.openUI(id)` / `game.closeUI(id)`: open a modal layer. This pauses the simulation, blocks gameplay input and releases pointer lock. Ids are free-form: `'inventory'`, `'shop'`, `'map'`, `'pause'`, `'missions'`...
- `game.setPaused(bool)`: pause menu. `game.startPlaying()`: title "Play" button (unlocks audio, grabs pointer).
- `game.settings` (see `DEFAULT_SETTINGS` in config.js) + `game.saveSettings()`: persists and emits `settingsChanged`.
- `game.seed`, `game.params` (URLSearchParams; `?autostart=1` skips the title, `?seed=N`).
- `game.scene`, `game.camera` (PerspectiveCamera, rotation order 'YXZ', added to scene), `game.renderer`.
- `game.debug`: an open object. Modules may add debug helpers in `init()` (e.g. `game.debug.spawnCar = ...`). Core provides `teleport(x,[y],z)` and `stats()`.
- `window.game` is exposed for tests.

## 3. Core APIs

### 3.1 Events (`game.events`: `on(name, fn) → unsubscribe`, `once`, `off`, `emit(name, payload)`)

| Event | Payload | Typical emitter → listeners |
|---|---|---|
| `ready` | {} | main → all (all systems initialised) |
| `gameStart` | {} | game.startPlaying → audio, hud |
| `pauseChanged` | {paused} | game → menus, audio |
| `uiChanged` | {open, id, ids} | game → hud, touch |
| `pointerLockChange` | {locked} | input → menus (lost lock while playing ⇒ open pause menu) |
| `settingsChanged` | settings | game → world (render distance), audio, camera |
| `entityDamaged` | {entity, amount, info} | entity owners → hud (player), police, peds |
| `entityKilled` | {entity, info} | entity owners → police, missions, peds, pickups |
| `gunfire` | {shooter, position, weapon} | combat → peds (flee), police (crime if shooter is player) |
| `explosion` | {position, radius, power, source} | combat → peds, police, vehicles, audio/fx (combat already calls fx/audio) |
| `crime` | {type, position, severity} | anyone → police. Types: `'assault','murder','carjack','vehicleTheft','copAssault','copMurder','explosion','gunfire','vandalism','hitAndRun'` |
| `vehicleEnter` | {vehicle, character, stolen} | vehicles → hud (vehicle name), audio (radio), police, missions |
| `vehicleExit` | {vehicle, character} | vehicles → audio, missions |
| `vehicleDestroyed` | {vehicle, source} | vehicles → police, missions |
| `blockBroken` | {x, y, z, id, byPlayer} | player → missions, save |
| `blockPlaced` | {x, y, z, id, byPlayer} | player → missions, save |
| `moneyChanged` | {money, delta, reason} | player.addMoney → hud |
| `inventoryChanged` | {} | inventory → hud |
| `healthChanged` | {health, armor} | player → hud |
| `playerDied` | {info} | player → hud (WASTED), police (clear), missions (fail) |
| `playerRespawned` | {reason: 'death'|'busted'|'load'} | player → camera, missions |
| `busted` | {} | police → player/hud/missions |
| `wantedChanged` | {level, prev} | police → hud, audio |
| `missionStarted` / `missionPassed` / `missionFailed` | {mission, reward?, reason?} | missions → hud, audio, save |
| `pickup` | {type, amount, position} | pickups → hud, audio |
| `shopOpened` / `shopClosed` | {shop} | shops |
| `weaponFired` | {weapon, byPlayer} | combat → hud (crosshair kick) |
| `weaponChanged` | {item} | inventory → hud, combat |

### 3.2 Input (`game.input`, `src/core/input.js`)

Use **actions**, never raw keys:

- `down(a)`, `pressed(a)` (edge), `released(a)`. Pass a 2nd arg `true` to read while UI is open.
- `moveAxis()` → `{x: right+, y: forward+}`
- `lookRadians()` → `{yaw, pitch}` deltas already scaled by sensitivity/invert. Add them to your yaw/pitch.
- `wheel` (+1 = next slot)
- `locked`, `lockFailed`, `requestLock()`, `exitLock()`
- Touch: `setVirtual(action, down)`, `setVirtualAxis(x, y)`, `addLook(dx, dy)`

Actions and default keys:

| Action | Keys | Notes |
|---|---|---|
| forward / back / left / right | WASD, arrows | |
| jump | Space | car: handbrake; heli: ascend |
| sprint | Shift | heli: descend |
| crouch | X, Z | sneak, swim dive, creative fast fly. Never Ctrl: Ctrl+W closes the browser tab |
| handsUp | B | hold to surrender (player.handsUp) |
| enterVehicle | F | |
| camera | C, V | |
| inventory | E | |
| reload | R | |
| horn | H | |
| lights | L | |
| radio | N | |
| grenade | G | |
| drop | Q | |
| map | M | |
| missions | J | |
| pause | Esc, P | |
| slot1..slot9 | 1–9 | |
| attack | LMB | |
| aim | RMB | |
| pick | MMB | |

### 3.3 Entities (`game.entities`, `src/core/entities.js`)

Register every damageable thing with `game.entities.add(e)` and remove it on despawn. See the interface comment at the top of `entities.js`. Key fields: `id, kind, team, position (bottom-centre), velocity, radius, height, health, maxHealth, alive, damage(amount, info), hidden`. `damage()` implementations **must** emit `entityDamaged` and, on death, `entityKilled`. Queries: `query(center, radius, filter)`, `nearest(center, maxDist, filter)`, `raycast(origin, dir, maxDist, ignore, filter) → {entity, distance, point}`.

Damage `info.source` is the entity responsible. For anything the player causes (bullets, explosions, their vehicle running someone over), pass **the player entity** (`game.player`) so police and missions can attribute crimes.

### 3.4 Physics (`src/core/physics.js`)

- `moveBox(world, pos, hw, h, vel, dt, {stepHeight}, out)` → `{onGround, hitX, hitY, hitZ, hitCeil, stepped, inWater, headInWater}`. Gravity is the caller's job (`PHYS.GRAVITY` = 30).
- `boxCollides(world, x, y, z, hw, h)`
- `voxelRaycast(world, origin, dir, maxDist, {hitLiquid, hitNonSolid})` → `{x, y, z, id, normal, point, distance}` | null
- `findGround(world, x, z, startY)` → standing y | -1
- `hasLineOfSight(world, from, to)`

### 3.5 Blocks (`src/world/blocks.js`)

`BLOCKS[id]` defs, `B.KEY` → id, `PLACEABLE_BLOCKS`, `breakTime(id, tool)`, `allTextureNames()`. Notable fields: `solid, opaque, transparent, cutout, liquid, shape ('cube'|'cross'), emissive, hardness, tool, color, tex{top,side,bottom}, value ($ when mined), explosive (TNT), blast (resistance), placeable, drops`.

- `value`: cash paid when the player mines a **naturally generated** block; player-placed blocks pay nothing (the player checks `world.edits`). Ores are a side income, missions stay the main one: coal 3, iron 8, gold 25, diamond 80.
- `placeable` (default true): appears in the creative palette (`PLACEABLE_BLOCKS`) and can be held as an item. Ores are `placeable: false` and `drops: B.COBBLESTONE`, so mining one gives cobblestone plus cash and ores never become items (no place-and-mine loop).
- `drops`: block id added to the inventory when mined (default: itself; 0 = nothing).

### 3.6 Humanoid (`src/entities/humanoid.js`)

`new Humanoid(look)` → `.root` (add to scene; set position = feet, rotation.y = yaw). `.animate(dt, {speed, aiming, aimPitch, state: 'normal'|'dead'|'sit'|'swim'|'air'|'hands_up', crouch})`, `.punch()`, `.flash()`, `.setHeld(object3D)` (item built pointing +Z), `.setVisible(b)`, `.dispose()`. Looks: `LOOKS.player|cop|swat|gang`, `randomLook(rng)`. `HUMANOID_HEIGHT = 1.8`, `HUMANOID_RADIUS = 0.3`.

### 3.7 Items & weapons (`src/data/items.js`, `src/data/weapons.js`)

Items: `{kind:'block', id, count}`, `{kind:'weapon', id, mag, reserve}`, `{kind:'tool', id:'pickaxe'|'axe'|'shovel'}`. `WEAPONS[id]` stats (kind melee/hitscan/projectile/throw). `TOOLS`. `SHOP_WEAPONS`. `starterInventory()`.

## 4. Shared formats

### 4.1 City plan (`game.generator.plan`), produced by the generator and consumed by everyone

```
plan = {
  seed, sizeX: 512, sizeZ: 512,
  spawn: { x, y, z, yaw },                         // player start (on a sidewalk near the safehouse)
  sidewalkWidth: 3,
  nodes: [ { id, x, z, edges: [roadIndex...] } ],    // road graph vertices: intersections, bends, dead-ends (x,z = centre, floats)
  roads: [ { id, a: nodeId, b: nodeId, width, lanes, speedLimit, kind } ],
          // straight segment a→b (axis-aligned in the city). width = total asphalt width in blocks, lanes = lanes PER DIRECTION,
          // speedLimit m/s, kind: 'street'|'avenue'|'highway'|'country'
  lots: [ { id, x0, z0, x1, z1, type, height, district } ],
          // type: 'building'|'tower'|'house'|'park'|'plaza'|'parking'|'shop'|'industrial'|'empty'. x1/z1 exclusive.
  pois: [ { id, type, name, x, y, z, yaw } ],
          // type: 'safehouse'|'hospital'|'police'|'gunshop'|'hardware'|'garage'|'mission'|'helipad'|'mine'|'beach'
          // (x,y,z) = standing point in front of the entrance (on the sidewalk), yaw = facing the entrance
  parkingSpots: [ { x, y, z, yaw } ],               // where parked cars can spawn
  // queries (fast, O(1)-ish; work for any x,z in the world, out-of-range => sensible defaults):
  surfaceY(x, z) → standing height of the terrain/street at column (ignores building interiors/roofs)
  isRoad(x, z) → bool       // asphalt / road paint (incl. intersections)
  isSidewalk(x, z) → bool
  isWater(x, z) → bool
  lotAt(x, z) → lot | null
  roadAt(x, z) → road | null          // nearest road segment containing (x,z) within its asphalt
  nearestNode(x, z) → node | null
  districtAt(x, z) → { id, name }     // e.g. {id:'downtown', name:'Downtown'}; HUD shows the name when it changes
  colorAt(x, z) → 0xRRGGBB            // top-down map colour for minimap / full map
  poisOfType(type) → poi[]
}
```

### 4.2 Raycast hit (world): `{ x, y, z, id, normal: Vector3, point: Vector3, distance }`

### 4.3 Vehicle controls (`vehicle.controls`), written by whoever drives (player input, traffic AI, police AI)

`{ throttle: -1..1 (neg = reverse/brake), steer: -1..1 (+ = turn RIGHT), brake: 0..1, handbrake: bool, lift: -1..1 (heli only) }`

### 4.4 Sound names (`game.audio.play(name, opts)`)

`gunshot_pistol, gunshot_smg, gunshot_shotgun, gunshot_rifle, gunshot_sniper, rocket_launch, explosion, grenade_bounce, punch, melee_swing, reload, empty_click, bullet_impact, glass_break, block_break, block_place, block_hit, footstep, jump, land, splash, car_door, horn, crash, tire_screech, pickup, money, hurt, death, ui_click, ui_open, mission_start, mission_passed, mission_failed, wanted_up, wanted_lost, siren_chirp, tnt_fuse, checkpoint, purchase, error`.
Unknown names are ignored with one console.warn.

### 4.5 FX calls (`game.fx`)

`burst(pos, {color, count, speed, size, life, gravity})`, `blockBreak(x, y, z, blockId)`, `explosion(pos, radius)`, `muzzleFlash(pos, dir)`, `tracer(from, to, color?)`, `blood(pos, dir)`, `sparks(pos, normal)`, `smoke(pos, {amount, color?})`, `fire(pos, duration) → handle{stop()}`, `splash(pos)`, `impact(point, normal, blockId)`.

### 4.6 Minimap blips (`getBlips(out)` on any system; HUD calls `game.collectBlips()`)

`{ x, z, color: '#rrggbb', shape: 'dot'|'square'|'triangle'|'star'|'ring'|'arrow', size: px(default 6), label?: string, icon?: 'car'|'gun'|'cash'|'mission'|'hospital'|'police'|'shop'|'home'|'pickaxe'|'garage', edge?: bool (clamp to minimap edge when off-range), flash?: bool, radius?: metres (draws a world-scaled circle e.g. police search area) }`

---

## 5. Module APIs

### §Generator (`src/world/generator.js`, `export class Generator`, WORLD-GEN agent)

- `constructor(game, seed)`, `init()`: builds `this.plan` (§4.1) deterministically from seed. Must be fast (< 1.5 s).
- `generateChunk(cx, cz) → Uint8Array(16*16*96)`: a pure function of (seed, cx, cz). Content spanning chunk borders (trees, buildings, roads) must be derived from the plan or position hashes so neighbouring chunks agree. Target < 4 ms per chunk.
- Must fill **every** column (bedrock at y=0, no holes to the void). Ocean ring around the edges of the 512² map acts as the natural boundary.
- **Content vision:**
  - A ~320×320 city in the middle on a road grid: downtown skyscrapers (glass/concrete towers up to ~80 blocks, lit windows), mid-rise districts, a residential area with houses and gardens, an industrial/port zone with warehouses and crates, a central park with trees, pond and paths, plazas, parking lots, street lamps (LAMP blocks on poles), lane markings (dashed white lines, double yellow centre), crosswalks, and a beach + boardwalk + palm trees on the east coast.
  - Countryside beyond the city: rolling hills, forests, a mountain range to the north with snow caps, exposed stone, and caves or a mine entrance with **ores** (coal/iron/gold/diamond, deeper = rarer). The roads leave the city and loop through the countryside.
  - Building interiors may be hollow with floors every 4 blocks in some buildings (enterable lobby with a door gap at street level).
  - POIs (§4.1) with distinct facades, e.g. gun shop with red/black stripes, hospital white + red cross from wool, police station blue, hardware store orange, garage with hazard stripes, safehouse.
  - Sidewalks are flush with roads (same y). Do not raise curbs: cars must drive smoothly. City ground = CITY_LEVEL.

### §World (`src/world/world.js`, `export class World`, WORLD-ENGINE agent; also `src/world/textures.js`, `src/world/mesher.js`)

- `init(onProgress)`: build the texture atlas + chunk materials, then pre-generate and mesh the chunks around `plan.spawn` (radius = renderDistance) with progress.
- `chunks: Map<key, chunk>` (for stats), `edits: Map<'x,y,z', id>` (player-made changes, for saving)
- `getBlock(x, y, z) → id`. Integer coords. Out of range: y<0 → BEDROCK, y≥96 → AIR, outside x/z → AIR. Not-yet-generated chunk → **generate synchronously** (never return garbage).
- `isSolid(x, y, z)`. Outside the x/z range → **true** (invisible wall). y<0 true, y≥96 false.
- `setBlock(x, y, z, id, {record = true} = {}) → bool`: marks the chunk and touching neighbours dirty for remesh. Records into `edits` unless `record:false`.
- `raycast(origin, dir, maxDist, opts)`: delegate to `voxelRaycast(this, ...)`.
- `findGround(x, z, startY?)`
- `explode(center: Vector3, radius, power) → removed: Array<{x, y, z, id}>`: removes blocks within a sphere (slightly noisy edge) whose `blast <= power`. Never removes bedrock or water. **Do not prime TNT here** (combat inspects the returned list). Batch the remesh.
- `applyEdits(map)`: apply saved edits (also to chunks generated later).
- `update(dt)`: stream chunks around the camera (generate + mesh within a per-frame time budget ~4 ms, nearest first, load radius = settings.renderDistance), unload far chunks (dispose), remesh dirty chunks (budgeted, edits first), and update emissive brightness from `game.sky.nightFactor`.
- `textures` (`src/world/textures.js`): `atlasTexture` (THREE.Texture, NearestFilter), `uvFor(textureName) → {u0, v0, u1, v1}` (the atlas also contains mining-crack overlay stages `'destroy_0'` … `'destroy_9'`: transparent tiles with progressively more dark cracks, used by Player), `getIcon(blockId) → HTMLCanvasElement` (isometric 3-face 32×32 icon, used by HUD hotbar/inventory/shop), `getColor(blockId)`.
- **Rendering:** chunk meshes with face culling against opaque neighbours (including across chunk borders), per-vertex ambient occlusion, and a per-face directional shade (top 1.0, sides 0.8/0.65, bottom 0.5). Use three materials: opaque (MeshLambertMaterial + atlas + vertexColors, `alphaTest` for cutout leaves/plants), transparent (water/glass, `depthWrite:false`, rendered after opaque), and emissive (MeshBasicMaterial + atlas, brightness boosted at night). Cross-shaped plants render as two diagonal quads. Water top face sits slightly lower (0.875) when the block above is not water. 16-px pixel-art procedural textures for every name in `allTextureNames()`: grass, dirt, stone, ores with coloured specks, planks, log rings, bricks, tiles, asphalt grain, road paint, glass with frame, windows (lit and dark), neon, TNT, wool, hazard stripes, crate, sand, snow, leaves with holes, etc.

### §Sky (`src/world/sky.js`, `export class Sky`, ATMOSPHERE agent)

- `time` (hours 0–24, start 9.0), `dayLength` (seconds per full day, default 1200), `nightFactor` (0 day … 1 night, smooth through dusk/dawn), `sunDir` (Vector3), `setTime(h)`.
- Owns scene lighting: one DirectionalLight (sun/moon, optional shadows following the player when `settings.shadows`) + a HemisphereLight. Exposes them as `this.sun`, `this.hemi`.
- Gradient sky dome (follows camera), sun and moon sprites, stars at night, a blocky cloud layer (moving), `scene.fog` colour matched to the horizon, fog distance from `settings.renderDistance * 16`, and `renderer.setClearColor`.
- Fog contract (every fogged material, custom shaders included): Sky patches `ShaderChunk.fog_vertex` before any material compiles, so `vFogDepth = length(vec2(horizontal distance, vertical distance * 0.25))` from the camera. It is horizontal-weighted, so the loaded-chunk edge (a horizontal radius) stays hidden at any altitude and the ground below a heli or a rooftop stays crisp. `fog.far = renderDistance * 16 - 6` (x0.68 in rain) and `fog.near = 0.6 * fog.far`. Below the horizon, the dome equals the fog colour exactly (`uGround = horizon`, twilight glow masked above the horizon), so fully fogged geometry blends into the backdrop. Shaders that write their own fog must mix toward `fogColor` after the colour-space conversion, as three's built-in materials do.
- `game.debug.setTime(h)`.

### §FX (`src/fx/fx.js`, `export class FX`, ATMOSPHERE agent)

API in §4.5. Particles are pooled (InstancedMesh of small cubes for debris/voxel feel, plus sprites/points for smoke and fire). Hard cap ~2000 live particles. `explosion()` = fireball + smoke column + flying debris + brief PointLight flash + `game.cameraRig.shake(...)`. Tracers are short-lived line segments. `fire()` loops until stopped (burning cars).

### §Audio (`src/audio/audio.js`, `export class AudioSystem`, ATMOSPHERE agent, `runWhenPaused = true`)

- `unlock()` (on user gesture), `play(name, {position?, volume=1, pitch=1})`. Positional = distance attenuation (inaudible beyond ~80 m) + stereo pan relative to the camera.
- `loop(name, opts) → {setVolume, setPitch, setPosition, stop}`
- `createEngine(kind = 'car'|'truck'|'bike'|'heli') → {update(rpm01, throttle01, position), stop()}`
- `siren() → {setPosition, stop}` (wailing police siren)
- **Radio:** procedural music stations (≥ 3: e.g. synthwave, hip-hop beat, chiptune) that play while the player is in a vehicle. Action `radio` (N) cycles stations including OFF. Show the station name via `hud.notify`. Volume = settings.musicVolume.
- Ambient city hum / birds in countryside optional. Master volume = settings.volume. Mute while paused (except UI sounds).
- All sounds synthesised (oscillators, filtered noise, envelopes). No samples.

### §Combat (`src/combat/combat.js` + helpers, `export class Combat`, COMBAT agent; owns `src/data/weapons.js`)

- `updatePlayerWeapon(dt, item, {firing, firingPressed, aiming, reloadPressed})`: called by Player every frame on foot **only when the selected item is a weapon** (`kind:'weapon'`, including bat and grenade). Fists, tools and blocks are handled by Player (mining) with `combat.melee(...)` for punches. Handles fire rate, magazine/reserve (mutates the item's `mag`/`reserve`, emits `inventoryChanged`), reload timing, recoil (`cameraRig.addRecoil`), spread (less when aiming), muzzle flash, tracer, sounds, `gunfire` event. Aim comes from `game.cameraRig.getAimRay()`. Bullets travel from the camera ray, then from the player's hand toward the resolved hit point.
- `fire(shooter, origin, dir, weaponId) → hit|null`: generic shot used by AI (cops, gang peds). Hits blocks and entities via raycasts. Bullets break GLASS/WINDOW blocks, prime TNT and spark on other blocks.
- `melee(attacker, origin, dir, damage, range) → entity|null`: punches/bats; the player's fist on a block does nothing here (mining belongs to Player).
- `explode(position, {radius, power, damage, source})`: `world.explode`, damage with falloff + knockback to entities in radius (vehicles take big damage), prime TNT among removed blocks (chain reaction, 1.5–3 s fuse, flashing primed-TNT entity), `fx.explosion`, `audio.play('explosion')`, camera shake, `explosion` event, `crime` if source is the player.
- `throwGrenade(thrower, origin, dir, power)`: bouncing grenade with fuse.
- Rockets: visible projectile with smoke trail, explode on impact.
- `getWeaponViewModel(id) → THREE.Object3D`: voxel-style weapon model (pistol, SMG, shotgun, rifle, sniper, RPG, bat, pickaxe...) built pointing +Z, used for the third-person hand (`humanoid.setHeld`) and the first-person view model (Player/CameraRig).
- Player damage handling (armor absorbs 60% until depleted) is in Player.damage, not here.

### §Inventory (`src/player/inventory.js`, `export class Inventory`, PLAYER agent; owns `src/data/items.js`)

- `slots` (36: 0–8 hotbar, 9–35 backpack), `selected` (0–8), `creative` (infinite blocks, full palette).
- `getSelected()`, `select(i)` (emits `weaponChanged`), `addItem(item) → bool` (merges stacks), `addBlock(id, n) → bool`, `removeBlock(id, n) → bool`, `countBlock(id)`, `addWeapon(id, ammo)` (adds or tops up reserve), `addAmmo(weaponId, rounds)`, `hasWeapon(id)`, `clearWeapons()` (busted), `setCreative(bool)`, `serialize()` / `deserialize(obj)`.
- `update()`: hotbar selection via slot1..9 and wheel (when no UI open).
- Emits `inventoryChanged` on any change.

### §Player (`src/player/player.js`, `export class Player`, PLAYER agent; also `src/player/interact.js` if desired)

- Entity (§3.3) with `kind 'player'`, `team 'player'`, radius 0.3, height 1.8. Fields: `yaw` (BODY facing, used for the model), `health` 100, `armor` 0..100, `money`, `alive`, `inVehicle` (Vehicle|null), `humanoid` (Humanoid), `onGround`, `inWater`, `aiming` (bool). The VIEW direction lives in `game.cameraRig.yaw/pitch` (the camera rig consumes `input.lookRadians()`). On-foot movement is camera-relative (GTA style): W moves toward the camera's yaw.
- Movement: walk 4.3 m/s, sprint 7.5, crouch 1.8, jump (≈1.25 blocks high), swim (Space up), fall damage over 4 blocks, auto-step (settings.autoJump), and a gentle collision push-out from other entities. Character faces the movement direction in third person (and the aim direction when aiming).
- Mining/building (Minecraft): LMB on a block within 5 m (with a block/tool/empty hand selected) mines it. Progress = `breakTime(id, tool)`, shown by a crack overlay mesh on the targeted block (atlas tiles `destroy_0..9` via `game.world.textures.uvFor`). A thin wireframe highlight shows the targeted block. Broken block: `world.setBlock(...,0)`, `fx.blockBreak`, `audio.play('block_break')`, drop into inventory (`def.drops`), ore `value` → `addMoney(value, 'mining')` + notify. Emit `blockBroken`. RMB with a block item places it on the hit face (not inside any entity; consumes one unless creative), `audio 'block_place'`, emit `blockPlaced`. MMB pick block (creative). Swinging arm animation.
- Weapons: when the selected item is a weapon, each frame call `game.combat.updatePlayerWeapon(dt, item, {...})`. RMB = aim (camera zoom/over-shoulder). With an empty hand, tool or block item: LMB on an entity in reach = `game.combat.melee(player, eye, dir, damage, 2.6)` (fist 12 dmg, tools per `TOOLS[id].damage`), and LMB on a block = mine.
- `frozen` (bool): when true, ignore all movement/action input (set by Police during BUSTED and by Missions for short cutscenes).
- `damage(amount, info)`: armor absorbs first, `hud.flashDamage`, `audio 'hurt'`, `healthChanged`. At 0: `alive=false`, death animation, emit `playerDied`. After ~4 s respawn at the nearest hospital POI (lose $100, keep weapons) with `respawn()`.
- `respawn(at = nearest hospital, reason='death')`: full health, clears velocity, emits `playerRespawned`.
- `teleport(x, y, z)`, `addMoney(delta, reason)` (emits `moneyChanged`; money never negative), `heal(n)`, `addArmor(n)`.
- `setInVehicle(vehicle|null, exitPos?)`: called by Vehicles. Hides/shows the humanoid, sets `hidden` on the entity while inside, places the player at `exitPos` on exit.
- While `inVehicle`: skip on-foot physics. Vehicles keeps `player.position` synced to the vehicle.
- Exposes `getBlips(out)`: none (HUD draws the player arrow itself).

### §CameraRig (`src/player/camera.js`, `export class CameraRig`, PLAYER agent)

- Modes: `'third'` (over-the-shoulder, default), `'first'`, `'far'` (cycle with `camera`). In vehicles: chase cam (distance from `vehicle.def.camDistance`, height `camHeight`) with mouse orbit that auto-recentres behind the car after ~1.5 s, plus a hood/first-person cam.
- Collision: pull the camera in when a block is between target and camera (voxel raycast).
- Aiming: RMB tightens over the shoulder and zooms FOV by `WEAPONS[id].zoom`.
- `getAimRay() → {origin, dir}` (camera centre ray, world space)
- `shake(intensity 0..1)`, `addRecoil(pitchRad, yawRad)`
- `yaw`, `pitch`, `mode`
- First-person view model: shows the held item (block/tool/weapon) at the bottom-right of the view in first-person, with bob and swing animation. `getWeaponViewModel` comes from combat, and block items render as a small textured cube.
- Smooth camera (damped follow), FOV kick while sprinting or at high vehicle speed.

### §Vehicles (`src/vehicles/vehicles.js` + helpers, `export class Vehicles`, `export const VEHICLE_TYPES`, VEHICLES agent)

- `VEHICLE_TYPES[type]` with: `name, kind ('car'|'bike'|'heli'), size {w, h, l}, mass, maxSpeed (m/s), accel, brake, steer, grip, health, colors[], camDistance, camHeight, seats, siren (bool), price`.
  - Minimum set: `sedan, sports, taxi, police, van, truck, bus, pickup, muscle, supercar, bike (motorbike), heli (player-flyable helicopter), police_heli, swat`.
- `list` (all live vehicles), `spawn(type, x, y, z, yaw, opts = {color, parked, locked}) → Vehicle`, `remove(v)`, `findNearest(pos, maxDist, filter) → Vehicle|null`, `enter(vehicle)` / `exit()` (for the player), `playerVehicle` (getter).
- **Vehicle** (also an entity: `kind 'vehicle'` or `'heli'`, `team 'neutral'` / `'police'`): `type, def, position, yaw, velocity, speed` (signed forward m/s), `controls` (§4.3), `driver` (`null | 'player' | 'ai'`), `ai` (opaque owner object set by traffic/police; may define `ai.release()`, `ai.onCarjacked(vehicle)`), `mesh` (THREE.Group), `health, maxHealth, alive, destroyed, onFire, isPolice, sirenOn, lightsOn, color`, `getBox(out)`, `forward(out)`, `damage(amount, info)`.
- **Physics** (arcade, fun-first): bicycle model with grip/drift (handbrake slides), speed-sensitive steering, ground following over voxel terrain (sample under the wheels, step up ≤1 block smoothly, fall off ledges with gravity, pitch/roll visually), wall collisions against solid blocks (bounce + scrape + damage ∝ impact speed + `crash` sound + sparks), vehicle↔vehicle collisions (OBB or circles, momentum exchange), hitting peds/cops/player (damage ∝ speed with `type:'vehicle'`, knockback; `source` = driver entity or the vehicle). Water: engine floods, the car sinks and is destroyed. Wheels spin and steer visually.
- **Helicopter** (`heli`): `lift` (Space up / Shift down), throttle = pitch forward/back, steer = yaw. Rotor animation, lands on any solid surface, takes damage from collisions.
- **Damage:** smoke below 40% health (`fx.smoke`), fire below 15% (`fx.fire`), explodes 4 s after catching fire or immediately at 0 when hit by an explosion. Explosion → `game.combat.explode(...)`, burnt-out dark model left behind (despawns later), `vehicleDestroyed`, kills occupants.
- **Player driving:** in `update`, if `playerVehicle`, map input to controls: forward/back throttle/brake-reverse, left/right steer, jump = handbrake, horn (police: toggles siren), lights, radio is handled by audio. Show the speed via HUD (`hud.setSpeed` if available, otherwise HUD reads `vehicles.playerVehicle.speed`).
- **Enter/exit (F, owned here):** on `enterVehicle`, if the player is on foot, pick the nearest vehicle within 3.5 m. If it has an AI driver: carjack, i.e. call `vehicle.ai?.onCarjacked?.(vehicle)` (the AI owner spawns a fleeing/angry ped from the driver seat), emit `crime {type:'carjack'}`. If it is a parked car: emit `crime {type:'vehicleTheft'}` with 50% chance (an alarm sound plays). Then `player.setInVehicle(v)`, `driver = 'player'`, `ai = null` (after calling `ai.release()`), emit `vehicleEnter`, and `hud.showVehicleName`. When in a vehicle, exit at a free spot beside the driver door: `player.setInVehicle(null, exitPos)`, emit `vehicleExit`. Show `hud.prompt('Press F to enter <name>')` when near a vehicle.
- Visuals: voxel-style low-poly models (box-built bodies with cabin, glass, bumpers, headlights, taillights that brighten on braking, police light bars flashing red/blue when `sirenOn`, taxi sign, bus windows...). Merge static parts per vehicle with vertex colours (≤ 6 draw calls per car). Headlights at night (emissive + an optional SpotLight only on the player's car). Engine sound via `audio.createEngine` for the player vehicle and the nearest few AI vehicles.
- Parked cars: on init and while streaming, spawn parked cars at `plan.parkingSpots` near the player (cap ~20, despawn far).
- `getBlips(out)`: the player's vehicle is drawn by the HUD. Optionally mark mission vehicles.

### §Traffic (`src/ai/traffic.js`, `export class Traffic`, NPC agent)

- Keeps ~14–22 AI cars (setting-scaled) driving on `plan.roads` near the player (spawn 60–140 m away, outside the camera frustum when possible; despawn beyond ~180 m). Uses `vehicles.spawn` and sets `vehicle.ai = <traffic driver>` and `driver = 'ai'`.
- Drives via `vehicle.controls` (pure-pursuit steering along lane centrelines, right-hand traffic). At nodes it picks the next road (avoids U-turns), slows for turns, respects `speedLimit`, keeps distance to the car ahead (ray/box look-ahead), brakes for pedestrians/player in front, honks when blocked for a few seconds, and goes around obstacles or reverses when stuck.
- Panic: when `gunfire`/`explosion` happens nearby, drivers speed up / flee. When hit by the player's car, a driver may get out and fight or flee.
- `ai.onCarjacked(vehicle)`: spawn the driver as a ped next to the driver door via `game.peds.spawnPed(pos, {look, mood: 'flee'|'fight'})`, then stop controlling the car.
- `ai.release()`: stop controlling.
- A mix of types: sedan, taxi, van, truck, bus (rare), sports (rare), pickup, muscle.

### §Peds (`src/ai/peds.js`, `export class Peds`, NPC agent)

- ~25–40 pedestrians (Humanoid with `randomLook`) walking sidewalks along the road graph near the player; spawn/despawn like traffic (not in view when possible). Crossing at intersections. Some idle at POIs/parks, chat in pairs, sit on benches (optional).
- Entity `kind 'ped'`, `team 'civilian'`, health 60. `damage()`: flinch + `humanoid.flash()` + `fx.blood`. Death: ragdoll-ish fall (`state:'dead'`), body despawns after 20 s, drops `pickups.spawn('cash', pos, 5..60)`. Emit the contract events.
- Reactions: `gunfire`, `explosion` and nearby deaths make peds within ~30 m panic (run away from the source, screaming optional). Being punched → 30% fight back (melee), else flee. A few **gang members** (`LOOKS.gang`, `team 'gang'`) in one district carry pistols and shoot back with `game.combat.fire` when attacked.
- `spawnPed(pos, opts = {look, mood: 'calm'|'flee'|'fight', team, weapon}) → ped`, `list`, `panicAt(position, radius)`.
- Peds get hit by cars (vehicles calls `damage` + `knockback`). Peds avoid walking into roads except at crossings and dodge cars that are about to hit them.

### §Police (`src/ai/police.js` + helpers, `export class Police`, POLICE agent)

- **Wanted level** `wanted` 0–5 (stars). `addHeat(points, reason)`, `setWanted(n)`, `clearWanted()`, emits `wantedChanged`, `audio 'wanted_up'`. Crime → stars (cap 5): assault on a civilian (+1 if witnessed by a cop within 40 m, else +1 only on the 2nd offence), murder +1, killing a cop +2, carjack +1, stealing a police vehicle +2, explosion +1, gunfire within 50 m of a cop +1, `hitAndRun` +1. Listen to `entityDamaged`/`entityKilled` (source === player), `crime`, `gunfire`, `explosion`, `vehicleEnter` (stolen / police car).
- **Response by level:** 1★ one patrol car, 2★ 2–3 cars, 3★ 3–4 cars + officers shoot to kill, 4★ police helicopter + SWAT van, 5★ max units and roadblocks (optional). Cops spawn as police cars on roads 70–130 m away and drive to the player (pursuit steering via `vehicle.controls`: road-following when far, direct chase when close, ramming at higher levels). When near a player on foot (≤ 18 m), officers (Humanoid `LOOKS.cop`, `kind 'cop'`, `team 'police'`, health 100, pistol; SWAT: rifle + armor) exit and engage: take cover-ish positions, shoot with `game.combat.fire` (accuracy scales with stars, never laser-perfect), melee at 1★ (try to arrest).
- **Evasion (GTA V style):** the police know the player's position while any cop/heli has line of sight within ~70 m. Otherwise they search around the last known position, and a search-area circle blip (`radius`, flashing red/blue) is shown. Out of sight for `8 + 4*stars` seconds → wanted clears (`audio 'wanted_lost'`, `hud.notify`). Garage POI (pay & spray) clears wanted for $250 (Shops calls `clearWanted`).
- **Busted:** wanted ≥ 1, player on foot, a cop within 2 m, and the player moving slowly or hands-up for 1.5 s → `busted` event (the HUD shows BUSTED; do not call bigMessage yourself), set `player.frozen = true` for ~3 s, then respawn at the nearest police POI with `player.respawn(poi, 'busted')`, lose weapons except the pickaxe (`inventory.clearWeapons()`) and 10% money, clear wanted.
- On `playerDied`: clear wanted and despawn the pursuit gradually.
- Police helicopter at 4★+: a `vehicles.spawn('police_heli')` hovering ~25 m above the player with a searchlight (SpotLight) at night and a sniper/rifle shooter.
- Sirens: `audio.siren()` on chasing cars, light bars (`vehicle.sirenOn = true`).
- `getBlips(out)`: cop cars and officers as blue/red flashing dots. Search area.
- `game.debug.setWanted(n)`.

### §Pickups (`src/missions/pickups.js`, `export class Pickups`, MISSIONS agent)

- `spawn(type, position, amount, {respawn: seconds|0, persistent}) → pickup`. Types: `'cash', 'health', 'armor', 'weapon:<id>', 'ammo:<id>', 'block:<id>'`. Floating, rotating, bobbing voxel models with a glow. Collected by walking within 1.4 m (or driving through for cash): apply the effect (`player.addMoney`, `heal`, `addArmor`, `inventory.addWeapon/addAmmo/addBlock`), `audio 'pickup'/'money'`, `hud.notify`, `pickup` event. Cash despawns after 30 s if `amount` was a drop.
- On init, scatter world pickups: health near the hospital, armor at the police station, a few weapons (bat, shotgun, SMG) and cash bundles hidden around the map (rooftops, alleys, mountain, mine), TNT crates at the quarry. These respawn after 120 s.
- `getBlips(out)`: weapon/health/armor pickups nearby (small icons).

### §Shops (`src/missions/shops.js`, `export class Shops`, MISSIONS agent)

- Walk into a shop POI marker (glowing ring on the ground in front of `poi`): opens a shop panel via `game.openUI('shop')` + `hud.openPanel(title, element, {onClose})`.
  - **Gun shop:** buy weapons (`SHOP_WEAPONS`, price) + ammo refills, armor ($200).
  - **Hardware store:** blocks in stacks of 16/64 (Minecraft-style building supplies), TNT, tools (axe, shovel). Toggle **Creative mode** (free, unlimited blocks).
  - **Hospital:** heal for $50.
  - **Garage (pay & spray):** while in a vehicle, drive into the marker: repair + new colour + clear wanted for $250.
  - **Safehouse:** save the game (`game.save.save()`), set the respawn point, sleep to skip to morning (`sky.setTime(8)`).
  - Not enough money → `audio 'error'` + notify. Purchase → `audio 'purchase'`, `player.addMoney(-price, 'purchase')`.
- `getBlips(out)`: shop icons (always visible, `edge:false`).

### §Missions (`src/missions/missions.js`, `export class Missions`, MISSIONS agent)

- Mission givers = POIs of type `'mission'` (+ any others the agent chooses): yellow glowing marker with a letter, blips on the map. Walk in → mission intro (`hud.bigMessage(title, subtitle)`) → start. One active mission at a time. `hud.setObjective(text)`, `hud.setTimer(sec|null)`, waypoint (`hud.waypoint = {x, z}` / destination blip with `edge: true`).
- **At least 6 missions mixing both genres** (examples):
  1. *Joyride*: steal a specific sports car parked across town and bring it to the garage undamaged-ish.
  2. *Checkpoint Race*: timed race through ~10 checkpoint rings (vertical voxel arches) in any car.
  3. *Package Run*: collect 5 packages scattered on rooftops/alleys within a time limit.
  4. *Demolition Contract*: blow up a marked condemned building with TNT/explosives (count removed blocks in its lot).
  5. *Diamond Rush*: mine N diamond/gold ores in the mountain mine and return.
  6. *Hit*: eliminate a marked gang leader (target ped with bodyguards via `peds.spawnPed`), escape the 2★ wanted level.
  7. *Builder*: build a structure (e.g. place ≥ 40 blocks inside a marked plot) with the materials provided.
  8. *Taxi side job*: in a taxi, press nothing; passengers spawn, drive them to destinations for fares (optional).
- Pass: reward money + `hud.bigMessage('MISSION PASSED', '$X', ...)` + `audio 'mission_passed'`, `missionPassed`. Fail (death, busted, timer, vehicle destroyed): `missionFailed`. Track `completed` (Set of ids). A Mission Log panel (action `missions`, J) lists missions and status.
- Start the player with a short tutorial hint chain via `hud.notify` (move, F to enter car, M map, E inventory, mine/build...).

### §Save (`src/missions/save.js`, `export class SaveSystem`, MISSIONS agent)

- `save()`, `load() → bool`, `hasSave()`, `clear()` (New Game). localStorage key `blockcity.save.v1`: money, health, armor, position, yaw, inventory (`inventory.serialize()`), completed missions, time of day, world edits (`world.edits` serialised compactly; cap ~50k entries), wanted (not saved; always 0).
- Autosave every 60 s while running, on mission passed, and at the safehouse. `init()` loads if a save exists (`?newgame=1` skips). Apply world edits with `world.applyEdits`.

### §HUD (`src/ui/hud.js` + `src/ui/minimap.js` + helpers, `export class HUD`, UI agent, `runWhenPaused = true`)

- **Loading screen:** `setLoading(p, text)`, `hideLoading()` (title logo, progress bar, tips).
- **Always-on HUD (GTA-style, bottom-left radar):** circular/rounded-square **minimap** rotating with the camera. Draw the pre-rendered 512×512 map from `plan.colorAt` (build once into a canvas), the player arrow, blips from `game.collectBlips()`, the waypoint, north indicator, and the district name on change (`showArea(name)`, polling `plan.districtAt`). Health (green) and armor (blue) bars under the radar. **Top-right:** money (`$1,234` with animated +/−), wanted stars (5 slots, filled flashing when changed), weapon icon + `mag / reserve`, clock (`sky.time`). **Bottom-centre:** Minecraft-style **hotbar** of 9 slots (block icons from `world.textures.getIcon`, weapon/tool emoji icons, counts, selected highlight, item name popup on change). **Crosshair** (dot on foot, expands when firing or moving; hidden in vehicles unless aiming). **Speedometer** in vehicles (km/h). **Mining crack progress** ring when mining (Player sets `hud.miningProgress`).
- **API used by others:** `notify(text, {duration=4, color})` (help-text box, top-left, queued), `bigMessage(title, subtitle='', {color, duration=3})` (WASTED in red, BUSTED, MISSION PASSED gold, overlay-style), `prompt(text)` (**per-frame**: the contextual prompt shows only while some system calls it each frame; it clears automatically), `setObjective(text|null)` (bottom-centre subtitle like GTA), `setTimer(seconds|null)`, `showVehicleName(name)` (bottom-right fade), `flashDamage(intensity)` (red vignette), `showArea(name)`, `openPanel(title, element, {onClose, width}) → panel`, `closePanel()`, `waypoint` ({x,z}|null), `miningProgress` (0..1|null), `setSpeed(kmh|null)` (optional).
- **Full-screen map** (action `map`, M; uses `game.openUI('map')`): pan/zoom, legend, POI icons, click to set or clear the waypoint (GPS line optional).
- **Inventory screen** (action `inventory`, E; `game.openUI('inventory')`): 9 hotbar + 27 backpack slots, click to pick up and swap stacks, a weapon list, a block palette in creative mode (click to get a stack of 64), and the player stats.
- **Death overlay:** "WASTED" with desaturation (CSS filter on the canvas) for ~4 s on `playerDied`. "BUSTED" on `busted`. The HUD is the ONLY place these two are shown. Mission pass/fail messages are NOT auto-shown by the HUD; Missions calls `bigMessage` itself.
- FPS counter when `settings.showFPS`.

### §Menus (`src/ui/menus.js`, `export class Menus`, UI agent, `runWhenPaused = true`)

- `showTitle()`: animated title screen over the live 3D scene (slow camera orbit), logo "BLOCK CITY", buttons: **Play** (calls `game.startPlaying()`; if a save exists, "Continue" + "New Game" (`save.clear()` + reload)), Controls, Settings. Short pitch line: "Build. Mine. Drive. Steal. Survive the cops."
- **Pause menu** (action `pause` while playing, or pointer lock lost while playing → pause): Resume, Settings, Controls, Save Game, New Game, toggle Creative mode. Uses `game.setPaused`.
- **Settings:** render distance (4–12), mouse sensitivity, invert Y, FOV, volume, music volume, shadows, show FPS, auto-jump, pixel ratio → `game.saveSettings()`.
- **Controls** panel listing all keys (§3.2) for on foot / driving / flying / building.
- When pointer lock is unavailable (`input.lockFailed`), show a hint that mouse movement over the game controls the camera.

### §Touch (`src/ui/touch.js`, `export class TouchControls`, UI agent, `runWhenPaused = true`)

- Only on touch devices (`matchMedia('(pointer: coarse)')` or `ontouchstart`), or with `?touch=1`. A left virtual joystick (→ `setVirtualAxis`), a right-half drag to look (`addLook`), and buttons: jump, attack (hold), aim/place, F (enter/exit), camera, inventory, reload, map, pause, plus hotbar taps. Large hit areas, semi-transparent, no interference with the 3D canvas otherwise.

---

## 6. File ownership

| Agent | Owns |
|---|---|
| core (orchestrator) | `src/main.js`, `src/core/*`, `src/world/blocks.js`, `src/entities/humanoid.js`, `src/index.html`, `tools/*`, `ARCHITECTURE.md`, `package.json` |
| WORLD-ENGINE | `src/world/world.js`, `src/world/textures.js`, `src/world/mesher.js`, `src/world/engine_*.js` |
| WORLD-GEN | `src/world/generator.js`, `src/world/gen_*.js` |
| PLAYER | `src/player/*`, `src/data/items.js` |
| VEHICLES | `src/vehicles/*` |
| NPC | `src/ai/traffic.js`, `src/ai/peds.js`, `src/ai/nav.js`, `src/ai/npc_*.js` |
| COMBAT | `src/combat/*`, `src/data/weapons.js` |
| POLICE | `src/ai/police.js`, `src/ai/police_*.js` |
| UI | `src/ui/*` |
| ATMOSPHERE | `src/world/sky.js`, `src/fx/*`, `src/audio/*` |
| MISSIONS | `src/missions/*` |

## 7. Build & test

- `npm run check`: `node --check` on every file + a full esbuild bundle (catches bad imports/exports).
- `npm run build`: produces `dist/index.html` (minified single file, the shippable game).
- `npm run build:dev`: produces `dist/dev.html` (unminified, with source maps).
- `npm run smoke -- --tag <your-agent-name> [--seconds 8] [--scenario file.mjs] [--eval "js"] [--shot .smoke/x.png] [--params "touch=1&newgame=1"] [--no-build] [--verbose]`. **Always pass `--tag <your agent name>`** so concurrent agents do not overwrite each other's build or screenshots (your build goes to `dist/dev-<tag>.html` and screenshots to `.smoke/<tag>/`). The command builds dev and boots the game in headless Chromium (SwiftShader WebGL, about 5–30 fps) with `?autostart=1`, runs an optional scenario, screenshots, and prints a JSON report (`pageErrors`, `consoleErrors`, `stats`). It exits 1 on errors.
  - Scenario module: `export default async ({ page, game, keys, wait, shot, log, gameWait, hold }) => result`. `gameWait(sec)` waits for SIMULATED seconds (headless runs far slower than real time). `hold('attack', 1.5)` holds a virtual action. `game(fn, arg)` evaluates `fn(window.game, arg)` in the page (it must be serialisable: no closures over Node variables). `keys('KeyW', 1500)` holds a key. Use `page.mouse` for clicks. Note: pointer lock does not work headless, so mouse-look tests should set `game.cameraRig.yaw` etc. directly.
  - Screenshots go to `.smoke/<tag>/` (gitignored). You can view a PNG with your file-reading tool to check visuals.
- Test pure logic directly with Node (`node -e "import('./src/world/generator.js').then(...)"`). `three` imports fine in Node. Avoid `document`/`window` at module top level so modules stay importable in Node.
