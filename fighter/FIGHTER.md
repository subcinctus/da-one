# LAST STANCE: Architecture & Module Contract

**Last Stance** is a third-person martial-arts revenge brawler for the browser, played on a **controller**.

- **Structure (Sifu):** a revenge story told through four chapters. Each chapter is a run of short fights through rooms, ending in a boss. A jade talisman revives you each time you die, but **older**.
- **Combat (Absolver):** four **stances**, attacks that flow from one stance to another, and a customisable **combat deck**. The deck has 8 slots: one *main* and one *alternate* attack per stance, half of Absolver's 16. Add to that guard, feints, a stamina economy, three defensive styles (parry / absorb / avoid), and learning moves by defending against them.
- **Tone:** serious, grounded, a little dry humour at the edges (boss quirks, deadpan lines).
- **Performance:** runs LIGHT, like Sloclap's games. Fighters are 1–2 draw calls each, environments are about 60 draw calls at most, there is no post-processing, and nothing is allocated per frame. Combat must stay crisp at 120 fps on a mid-range laptop.
- **Look:** light, clean, beautiful low-poly at **120 fps**. **No atmospheric effects**: no fog, bloom, volumetrics, ambient particles or post-processing. The only effects are **subtle, Absolver-like hit effects**: short limb trails, small impact flashes and shards, a few frames of hitstop, and gentle shake.

One self-contained HTML file. three.js r160 via esbuild. No assets, no network: everything is procedural, including the meshes, the poses and the WebAudio sound.

---

## 0. Rules for module agents

1. **Edit only the files you own (§12).** Core files belong to the orchestrator: `src/main.js`, `src/core/*`, `src/anim/rig.js`, `src/data/*`, `src/index.html`, `tools/*`, and this doc. If you need a core change, list it under `coreRequests` in your report and work around it meanwhile.
2. **Implement the contracted APIs exactly.** Other agents are coding against them in parallel without seeing your code. You may add more API, but never rename or remove contracted API.
3. **Code defensively across modules.** Other modules may still be stubs. Use optional chaining and `typeof fn === 'function'` checks, and never throw because another system returned `null`. Constructors must not touch other systems; wire things together in `init()` or lazily.
4. **No new dependencies.** Allowed: `three` (r160, `import * as THREE from 'three'`; `three/examples/jsm/...` allowed) and browser APIs. No network, no external assets.
5. **Run light, like Sloclap's games: a 120 fps budget.** Total frame time must stay under 8 ms on a mid-range laptop.
   - Your `fixedUpdate` runs 120 times per second. Keep it lean.
   - No per-frame allocations in hot paths.
   - Share geometries and materials. Use few draw calls (merge static geometry; aim for ≤ 15 meshes per fighter).
   - No post-processing passes.
   - One shadow-casting directional light at most (world owns it).
6. **Style.** ES modules, 2-space indentation, single quotes, semicolons, short doc comments on public API. `console.error` only for real errors: the smoke test fails on it.
7. **UI** injects its own CSS from JS and mounts under `#ui` (`pointer-events: none` by default; set `auto` on interactive panels). Use the CSS variables in `src/index.html`.
8. **Do not git commit.** Do not run npm install.
9. **Validate.**
   - `npm run check` from the repo root fails on this folder, so run `node tools/check.mjs` inside `fighter/`.
   - Run headless play-tests with `node tools/smoke.mjs --tag <you> ...` (§13).
   - Other agents edit their files at the same time. A failure in a file you don't own may be transient: don't fix it, report it.

## 1. Conventions

- **Units and axes:** metres, Y up. A fighter's local forward is **+Z**; its own **left is +X**, its **right is −X**.
- **Yaw θ:** forward = (sin θ, 0, cos θ), right = (−cos θ, 0, sin θ). Turning right decreases θ. Use the helpers in `core/math.js`.
- **Time:**
  - `game.time` is simulation seconds.
  - Simulation runs at a **fixed 120 Hz**: `fixedUpdate(dt)` with `dt = 1/120`.
  - Rendering runs every display frame: `update(realDt, alpha)`.
  - Use `alpha` to interpolate visual transforms between the previous and current sim states if you need smoothness. Fighters do this themselves (§5).
- **Hit feel:**
  - `game.hitstop(s)` freezes the simulation for `s` real seconds; typical values are 0.03–0.09.
  - `game.slowmo(scale, s)` slows the simulation down.
  - Both are owned by core; combat and FX call them.

## 2. Loop & systems (`core/game.js`, `main.js`)

**Registration / update order:** `flow, ai, combat, encounters, world, cameraRig, fx, audio, hud, menus, anim`.

**Init order:** `hud, menus, audio, anim, world, fx, cameraRig, combat, ai, encounters, flow`.

**System interface:** `init(onProgress)` (may be async), `fixedUpdate(dt)` (simulation), `update(realDt, alpha)` (visual), `onResize(w, h)`, and the flag `runWhenPaused`.

**Game state:**
- `game.state` is `'loading' | 'title' | 'playing'`.
- `game.paused` is the pause flag.
- `game.openUI(id)` / `game.closeUI(id)` open and close modal layers (deck editor, story cards, dialogue). These freeze the simulation and block gameplay input.
- `game.running` is true while simulating.
- `game.settings`: `volume`, `music`, `rumble`, `cameraSensitivity`, `invertY`, `shadows`, `pixelRatio`, `showFPS`, `hitPause`, `screenShake`. Persist with `game.saveSettings()`, which emits `settingsChanged`.

**Other globals:**
- `game.player` is the player `Fighter` (set by Combat).
- `game.debug` is an open object; add your helpers to it in `init()`.
- `window.game` is exposed for tests.

**URL parameters:** `?autostart=1` calls `flow.quickStart()` (chapter 1, default style, straight into play). `&chapter=<id>` and `&style=<id>` are optional.

## 3. Input (`core/input.js`)

Gameplay reads: `input.move {x, y}`, `input.look {x, y}`, `input.down(a)`, `input.pressed(a)`, `input.consume(a, window)`, `input.buffered(a)`, `input.stanceFlick()`, `input.padType` (`'xbox' | 'ps' | 'generic' | null`), and `input.rumble(strong, weak, ms)`. UI code passes `force = true` to read input while a UI layer is open. Virtual input for tests and overlays: `setVirtual(action, bool)`, `setVirtualMove(x, y)`, `setVirtualLook(x, y)`, `virtualStance(st)`.

| Action | Pad (Xbox / PS) | Keyboard / mouse | Meaning |
|---|---|---|---|
| light | X / □ | LMB, J | main attack: the current stance's **main** slot |
| heavy | Y / △ | RMB, K | **alternate** attack: the current stance's alt slot |
| guard | RB / R1 (hold) | Shift | block (stamina drain). A tap during the startup of your own attack = **feint** |
| dodge | A / ✕ | Space | dodge in the stick direction (back-step when neutral) |
| defend | B / ○ | E, L | style ability: **parry** (Forsaken), **absorb** (Kahlt), or **avoid** (Windfall) |
| lock | LB / L1 | Tab, Q | lock-on toggle |
| stance | RT / R2 (hold) + right-stick flick | R + WASD, or keys 1–4 | switch to the flicked stance quadrant |
| focus | LT / L2 | F | focus attack (spends focus meter) |
| target | RS click | T | cycle the locked target |
| pause | Start / Options | Esc, P | |
| deck | Back / Share | I | combat deck (only at rest points) |

`input.stanceFlick()` returns the stance chosen this frame (`'FR' | 'FL' | 'BR' | 'BL'`) or `null`. Up = front, down = back, right = R, left = L.

## 4. Rig & poses (`anim/rig.js`, core)

**Skeleton.** `createSkeleton()` returns `{ root, body, joints }`. There are 17 joints: `hips, spine, chest, neck, head, shoulderL/R, elbowL/R, wristL/R, thighL/R, kneeL/R, ankleL/R`. Offsets are in `OFFSET`. `STRIKE_POINTS` names the striking spots `handL/R, footL/R, elbowL/R, kneeL/R, head`; get their world positions with `strikePointWorld(skel, name)`.

**Pose (authoring, degrees).** Format: `{ joint: [x, y, z], root: { fwd, right, up, yaw } }`. Euler order is 'XYZ'. Missing joints mean rest.

**Rotation cheat-sheet** (rest = standing straight, arms hanging, facing +Z):

| Joint | +X | +Y | +Z |
|---|---|---|---|
| hips, spine, chest, neck, head | lean / nod **forward** | twist to **own left** | tilt to **own right** |
| shoulderL | arm swings **back** (−X raises the arm **forward**; −90 = punching height) | twist | arm raises **outward** (left side) |
| shoulderR | same as L (−X = forward) | twist | **−Z** raises **outward** (right side) |
| elbowL/R | — (−X = **bend**; forearm comes forward/up, 0 to −150) | twist | — |
| wristL/R | − = flex forward | | |
| thighL | leg **back** (−X lifts the leg **forward**: front kick ≈ −90) | turn leg out / in | **+Z** = leg out to the side |
| thighR | same X | | **−Z** = leg out to the side |
| kneeL/R | **+X = bend** (shin goes back, 0 to 150) | | |
| ankleL/R | + = toes down | | |
| root | fwd / right / up offsets in metres (lunges, crouches; up −0.3 = duck) | yaw in degrees (+ = turn left); back stances / spins | |

**Helpers:**
- `registerPose(name, pose)`, `getPose`, `resolvePose`, `mirrorPose(pose)`, `mergePoses(...poses)`, `mirrorTrack(track)`.
- `PoseBuffer` with `setPose`, `blend(a, b, t)`, `lerpTo`, `blendJoints`, `applyTo(skel)`.
- `sampleTrack(track, t, out)`, `trackDuration(track)`.

**Tracks.** A track is `{ duration, loop?, keys: [{ t, pose, ease? }] }`. `pose` is an object or a registered name. `ease` comes from `core/math.js` `EASE`: `linear, in, out, inOut, in3, out3, snap, back, hold`. It shapes the segment that **ends** at that key.

**Registered pose names.** The ANIM agent registers these and every move key may reference them:
- `'stance:FR' 'stance:FL' 'stance:BR' 'stance:BL'`: fighting-stance idles. Moves start and end exactly on these.
- `'guard:FR'` and the equivalents for the other three stances.
- `'neutral'`: relaxed standing, used out of combat.

## 5. Anim (ANIM agent: `src/anim/library.js`, `model.js`, `animator.js`, `clips*.js`, `trail*`)

**`AnimLibrary` (system `game.anim`):**
- `init()` registers stance, guard and neutral poses and all clips.
- `getClip(name)` returns a track.
- `clipNames()`.

**`createFighterModel(look)`** returns `{ root, skeleton, look, setTint(color, amount), setVisible(b), dispose() }`.

**Models.**
- **Style:** stylised low-poly masked martial artists in the spirit of Absolver. Faceted tapered limbs, flowing tunic or jacket, sash with tails, wrapped forearms, and a distinctive **mask** per character type.
- **Shading:** flat-shaded `MeshStandardMaterial` (roughness ~0.9) or Lambert, plus vertex colours. Merge static parts per bone.
- **Secondary motion:** scarf/sash tails and coat hem swing procedurally (cheap spring chains, ≤ 3 segments).
- **Looks (`look.preset`):**
  - `'player'`: white porcelain mask, jade sash.
  - `'thug'`: varied colours, cloth masks / bandanas.
  - `'brawler'`: big, bare arms.
  - `'swift'`: lean, hood.
  - `'heavy'`: wide, padded vest.
  - `'tadao'`: suit vest, spectacles mask, ledger strapped to the hip.
  - `'madame_shu'`: apron over a qipao, wok-lid shoulder guard.
  - `'brick'`: tank top, huge, headband.
  - `'mr_golden'`: gold-trimmed white suit, golden mask.
- **Extra fields:** `look.colors` overrides a palette; `look.seed` varies thugs.

**`new Animator(model)`:**
- `setLocomotion({ stance, vx, vz, speed, guard, locked, crouch })` is called every sim step. `vx`/`vz` are local m/s, +z forward and +x right. The base layer blends the stance idle with walk / strafe / back-step cycles in that stance, and the guard pose on the upper body when `guard`.
- `playAction(trackOrName, { fade = 0.06, speed = 1, loop = false, onEnd, startAt = 0, fromCurrent = true })` returns a handle `{ name, time, duration, done, stop() }`. `startAt` begins the track mid-way (combo chaining, §6b). It plays a move track (a move object with `.keys`) or a registered clip as a full-body override. The cross-fade always starts from the exact pose currently displayed.
- `freezeAction(seconds)` holds the current action pose (the strike hold in §6b).
- `stopAction(fade = 0.1)`.
- `update(dt)`: advance at sim rate and apply to the skeleton. Combat calls this from `fixedUpdate`.
- `lookAt(targetPos | null)`: subtle head/chest aim at the opponent.
- `strikePoint(name, out)`.

**Clips** (names fixed; durations are suggestions):
- **Dodges:** `dodge_left`, `dodge_right`, `dodge_back`, `dodge_forward` (≈0.35).
- **Avoids:** `avoid_duck` (0.4), `avoid_left`, `avoid_right` (0.35), `avoid_jump` (0.45).
- **Defence:** `parry` (0.3), `absorb` (0.5), `block_hit` (0.2).
- **Hit reactions:** `hit_high`, `hit_mid`, `hit_low` (≈0.35), `hit_heavy` (0.6), `guard_break` (0.8), `parried` (0.7 stagger).
- **Down and dead:** `knockdown` (1.0, ends lying), `getup` (0.8), `death` (1.4, ends lying).
- **Stance switches:** `stance_switch_<FROM>_<TO>` for all 12 ordered pairs (≈0.18; generated by blending the stance poses with a small step).
- **Focus:** `focus_ready` (slow-mo pose).
- **Character:** `taunt` and `intro_<bossId>` (boss intro poses), `victory`.

## 6. Moves (MOVES agent: `src/combat/moves/*.js`)

`src/combat/moves/index.js` exports:
- `MOVES`: an object of move id → move.
- `STARTER_DECK`.
- `ENEMY_DECKS`: named decks for archetypes and bosses.
- `FOCUS_MOVES` = `{ strike, sweep }`, two move ids.

**Move schema:**

```js
{
  id: 'fr_snap_jab', name: 'Snap Jab', desc: 'one short flavour line',
  start: 'FR', end: 'FL',               // stance at start / end (first & last keys are exactly 'stance:<start>' / 'stance:<end>')
  weight: 'light' | 'medium' | 'heavy', // feel + UI
  height: 'high' | 'mid' | 'low',       // duck avoids high, jump avoids low
  path: 'horizontal' | 'vertical' | 'thrust', // strafing (side avoid / strafe property) dodges vertical & thrust
  limb: 'handR' | 'footL' | ...,         // STRIKE_POINTS name: trail + impact point
  startup: 0.20, active: 0.07, recovery: 0.30,  // seconds at speed 1; duration = sum
  cancel: 0.33,                         // time from start after which the next attack may chain (>= startup+active)
  damage: 8, stamina: 9,                // health damage; stamina cost to the attacker
  guardDamage: 12,                      // stamina drained from a blocking defender
  reach: 1.7, arc: 70,                  // metres from attacker centre; total horizontal cone in degrees
  hitstun: 0.32, blockstun: 0.16,       // seconds
  push: 0.35,                           // knockback metres on hit (heavy ~1.0+, knockdown when props.knockdown)
  lunge: 0.4,                           // forward root motion metres during startup->active
  chainIn: 0.08,                        // COMBO FLOW: when chained from another attack, start this track at this time
                                        //   (skips the settle-from-stance part of the wind-up). Default 40% of startup.
  holdOut: 0.05,                        // COMBO FLOW: how long this move's strike pose lingers when chained out of it
  props: { break, stop, double, charge, duck, jump, strafe, knockdown },  // booleans, all optional
  hits: [{ t: 0.20, dur: 0.07, limb: 'handR', damage: 8 }], // optional: multiple hit windows (double)
  keys: [ { t: 0, pose: 'stance:FR' }, ..., { t: 0.57, pose: 'stance:FL' } ], // full-body pose keys
  learn: 100,                           // learning points to unlock (player)
  boss: false,                          // boss-only signature moves are excluded from the player's library
}
```

**Attack properties (Absolver):**
- `break`: breaks guard and pierces absorb.
- `stop`: on hit, interrupts the defender's attack startup and stuns longer.
- `double`: two hit windows.
- `charge`: hold the button to charge. That slows the attack and adds damage, and a full charge gains `break`.
- `duck`: the attacker ducks high attacks during startup.
- `jump`: the attacker hops over low attacks during startup.
- `strafe`: the attacker steps sideways, dodging thrust and vertical attacks during startup.
- `knockdown`: on hit the defender falls.

**Library:** 28–32 player moves, at least 6 starting in each stance, covering all heights and paths and every property at least once. Martial-arts flavours: jabs, straights, hooks, uppercuts, palm strikes, hammer fists, elbows, knees, front / side / roundhouse / spinning back kicks, crescent and axe kicks, sweeps, backfists. Each boss also gets **2 signature moves** (`boss: true`), all with good keyframed poses.

Hard rules:
- The first key is `'stance:<start>'` at t = 0, and the last key is `'stance:<end>'` at t = duration.
- The anticipation, strike and follow-through in between are readable: the limb reaches full extension at the hit time.
- Mirrored variants can be produced with `mirrorTrack`.

**Interconnected combos (Absolver).** Every attack ends in a stance, and the next attack comes from that stance's slots, so the whole library is one flow graph:
- Every stance has starters ending in at least 3 different stances.
- From any stance, every other stance is reachable within 2 moves.
- End poses set up the next stance's moves naturally. For example, a right hook that ends in FL has loaded the hips for a left body shot.
- The STARTER_DECK's main attacks form a loop through all four stances. The alternates branch off it.

### 6b. Combo flow: skip the animation, but never teleport (the Sloclap feel)

Chained attacks must feel **quick and fluid**, never like animations playing back to back, and never like a teleport. A move's timeline: `[0, startup)` wind-up, `[startup, startup+active)` strike, then recovery back to `'stance:<end>'` at `duration`.

- **Standalone.** With no follow-up, the move plays fully, including its recovery into the end stance.
- **Chained.** A follow-up attack is buffered (light or heavy) by the time the current move reaches `cancel`:
  1. **The recovery is skipped.** At the end of the current move's last active window, the animator **freezes the strike pose for `holdOut`** (default 0.05 s, about 6 frames at 120 Hz). The last attack's form visibly stays for a moment.
  2. **The follow-up starts `chainIn` seconds into its own track** (default 40% of its startup), cross-fading from the frozen strike pose over **`CHAIN_BLEND = 0.06 s`** (never below 0.04 s). That very short blend is the "tiniest glimpse" of the limbs moving from one form to the next: no snap, no full recovery.
  3. The follow-up's simulated move time starts at `chainIn`, so its real strike comes at `startup − chainIn` after the blend begins. Chains are faster than standalone attacks but still readable and reactable.
  4. The follow-up comes from the slots of the previous move's **end stance**.
  5. A string is at most 3 attacks. After the third, the move plays its recovery fully (string end) before a new string can start.
  6. Alternates can be inserted at any point with the same rules.
  7. **Defensive cancels:** dodge / defend / guard pressed after `cancel` also skip the recovery, with the same hold + fast blend.
- **Animator API.**
  - `animator.freezeAction(seconds)` holds the current action pose.
  - `animator.playAction(track, { startAt, fade, fromCurrent: true })` starts a track mid-way, blending from the exact current displayed pose, which may be frozen or mid-blend.
- **Combat** owns the timing and calls those two methods.

**Deck:** `deck = { FR: { main: moveId, alt: moveId }, FL: {...}, BR: {...}, BL: {...} }` (8 slots). A move may only occupy a slot of its own `start` stance. The STARTER_DECK uses 8 different moves that flow well. For example, chaining main attacks visits several stances.

## 7. Combat (COMBAT agent: `src/combat/*.js`, excluding `moves/`)

**`Combat` (system `game.combat`):**
- `fighters` (array).
- `spawnFighter({ team: 'player' | 'enemy', look, deck, style, position: {x, z}, yaw, health, ai?: string, boss?: bossId, name })` returns a Fighter. It creates the model with `createFighterModel` plus an `Animator`. For team `'player'` it sets `game.player`.
- `removeFighter(f)`, `clear()`.
- `enemiesAlive()` returns a **number** (count).
- `revive(fighter)`: getup in place, full health with the age multiplier. Flow's `revivePlayer()` calls `game.combat.revive(game.player)`.
- `nearestEnemy(f, maxDist)`.
- `MOVES` (re-export).
- `focus` handling.
- `game.debug.spawnEnemy(...)`.

**Fighter** fields:
- Identity: `id`, `team`, `name`, `boss`.
- Body: `position` (Vector3, feet), `yaw`, `velocity`, `radius` (0.35), `height` (1.8).
- Health: `health`, `maxHealth`, `stamina`, `maxStamina` (100), `focus` (0..100).
- Combat state:
  - `stance` (FR/FL/BR/BL), `deck`, `style` (forsaken / kahlt / windfall).
  - `state`: `'idle' | 'move' | 'attack' | 'recover' | 'block' | 'blockstun' | 'hitstun' | 'parry' | 'absorb' | 'avoid' | 'dodge' | 'stagger' | 'guardbroken' | 'knockdown' | 'getup' | 'dead' | 'switch'`.
  - `move` (current move) and `moveTime`.
  - `target` (locked Fighter or null).
  - `intent` (below).
  - `alive`.
- Rendering: `model`, `animator`, `ai` (brain).

**Intent.** Written each sim step by `PlayerController` (Combat-owned, reads `game.input` relative to camera / target) or by an AI brain:

```js
intent = { moveX, moveZ,            // desired world-space move direction * magnitude (0..1)
           light, heavy,            // attack presses (consumed on use; Combat buffers 0.2 s)
           guard,                   // held
           dodge, dodgeDir: {x, z}, // press + world direction (zero = back)
           defend,                  // style ability press
           stance,                  // 'FR'|'FL'|'BR'|'BL'|null : switch request
           focus, charge,           // focus press; charge = attack button still held (for charge moves)
           feint,                   // guard tap during own startup
           lockTarget }             // Fighter or null (player lock-on)
```

**Rules (Absolver feel):**
- **Facing.**
  - With a target, a fighter always turns toward it (fast turn, limited during attack active frames). Movement is strafing relative to the target.
  - The player without lock-on faces the movement direction, and attacks auto-aim at the nearest enemy within 3 m in front (soft lock).
- **Strings.**
  - `light` performs `deck[stance].main`; `heavy` performs `deck[stance].alt`.
  - Inputs during an attack's cancel window chain, following **§6b**: hold the strike pose for `holdOut`, skip the recovery, and start the next move at its `chainIn` with a 0.06 s blend. After a move ends, the fighter is in `move.end` stance.
  - A string is at most **3 attacks**. After the third, the next attack waits for a short string-end recovery (0.15 s).
  - Alternates may be used at any point in a string.
- **Stamina.**
  - Attacks cost `move.stamina`. Blocking drains `guardDamage`. Dodges cost 12 and avoids 8.
  - Regen is 30/s after 0.6 s without spending, and slower while guarding.
  - At 0 stamina, attacks still come out but with extra recovery, and getting hit while out of stamina causes a long stagger.
  - Attacks whiffed against no one still cost stamina.
- **Guard.**
  - Hold to block: −80% damage, stamina drain, blockstun. Blocks fail against attacks from behind.
  - A `break` attack on a guard → `guardbroken` (0.8 s, open).
  - Guard fully drained → guard break.
- **Feint.** Pressing guard during your own startup cancels the attack (costs 50% of its stamina).
- **Defensive styles:**
  - **Parry (Forsaken).** Window 0.20 s from the press.
    - Success: no damage, attacker `parried` (stagger 0.7 s), defender gains focus.
    - Failure: 0.35 s vulnerable recovery.
  - **Absorb (Kahlt).** A 0.5 s absorb stance.
    - Hits taken are reduced 60% with no flinch.
    - If the next attack lands within 1.2 s, heal back the absorbed damage.
    - `break` attacks pierce it.
  - **Avoid (Windfall).** Window 0.30 s.
    - Neutral stick → `avoid_duck`: avoids high attacks.
    - Left / right → `avoid_left` / `avoid_right`: avoids thrust and vertical attacks, and horizontal attacks from the far side.
    - Back → `avoid_jump`: avoids low attacks.
    - A successful avoid opens a 0.4 s counter window (+damage).
- **Dodges.** Iframes 0.08–0.26 s, about 2.2 m travel, and a 0.25 s recovery.
- **Hits.**
  - During a hit window, a target is hit when it is within `reach + target.radius`, inside `arc/2` of the attacker's facing, and not avoiding through `height` / `path` or invulnerable. One hit per window per target.
  - On hit:
    - damage, scaled by age (§9);
    - `hitstun`, with a reaction clip by height (`hit_heavy` for heavy moves);
    - `push`;
    - `stop` interrupts the defender's startup;
    - `knockdown` → `knockdown` + `getup`;
    - `game.hitstop(0.04..0.09)` by weight;
    - `input.rumble`, `cameraRig.shake`, FX and audio;
    - focus gain for the attacker.
  - Combo hits on a fighter already in hitstun use reduced hitstun (scaling) so infinite juggles are impossible.
- **Charge.** Hold the attack button on `charge` moves (up to 0.6 s extra) for up to +60% damage and `break` at full charge.
- **Focus (Sifu).**
  - The meter (0–100) fills from landing hits (+4), parries / avoids (+15), and blocks (+3).
  - `focus` + `light` at ≥ 50 performs `FOCUS_MOVES.strike`, an unblockable fast stun.
  - `focus` + `heavy` at 100 performs `FOCUS_MOVES.sweep`, a knockdown.
  - Pressing `focus` triggers `game.slowmo(0.25, 0.6)`.
- **Learning (Absolver).**
  - When the player blocks, parries, avoids or absorbs an enemy move the player has not learned, `flow.progress.learn[moveId]` increases: block +12, parry / avoid / absorb +30. Boss moves cannot be learned.
  - Reaching `move.learn` unlocks the move: `learned` event plus HUD toast.
- **Death.** health ≤ 0 → `dead` (`death` clip) and the `fighterDied` event. Combat does NOT respawn the player; Flow does (`flow.revivePlayer()`).
- **Locomotion.** About 2.6 m/s walking in stance, 1.8 m/s backwards, and 4.2 m/s running when the player is unlocked and the stick is fully pushed. Collision between fighters uses circle push-out. World bounds come from `game.world.clampPosition(pos, radius)` after each move.
- **Rendering.** Combat stores the previous and current positions and yaw per fighter and, in `update(dt, alpha)`, places `model.root` at the interpolated transform. It calls `animator.update` in `fixedUpdate`.

## 8. Events (`game.events`)

| Event | Payload | Emitter |
|---|---|---|
| `ready`, `gameStart` | `{}` | core / flow |
| `pauseChanged`, `uiChanged`, `settingsChanged`, `gamepad` | — | core |
| `attackStart` | `{ fighter, move }` | combat |
| `attackWhiff` | `{ fighter, move }` | combat |
| `hit` | `{ attacker, defender, move, damage, point: Vector3, dir: Vector3, heavy, counter, killed }` | combat |
| `blocked` | `{ attacker, defender, move, point, guardBroken }` | combat |
| `parried` | `{ attacker, defender, move, point }` | combat |
| `avoided` | `{ attacker, defender, move, kind: 'duck' / 'left' / 'right' / 'jump' / 'dodge' }` | combat |
| `absorbed` | `{ attacker, defender, move, point, pierced }` | combat |
| `feint` | `{ fighter, move }` | combat |
| `stanceChanged` | `{ fighter, from, to }` | combat |
| `staminaOut` | `{ fighter }` | combat |
| `guardBroken` | `{ fighter }` | combat |
| `knockdown` | `{ fighter }` | combat |
| `fighterDied` | `{ fighter, killer }` | combat |
| `focusAttack` | `{ fighter, kind }` | combat |
| `learnProgress` | `{ moveId, value, max }` | combat |
| `learned` | `{ moveId }` | combat |
| `roomStarted`, `roomCleared` | `{ room }` | encounters |
| `bossIntro`, `bossPhase`, `bossDefeated` | `{ bossId, ... }` | encounters |
| `chapterStart`, `chapterComplete` | `{ chapterId }` | flow |
| `playerAged` | `{ age, deaths, counter }` | flow |
| `gameOver` | `{ chapterId }` | flow |
| `dialogue` | `{ speaker, text, mood, block }` (`block`: true = modal dialogue box that pauses the sim) | encounters / flow → menus show it |
| `enemyTelegraph` | `{ fighter, move }` (an AI is about to attack: brief readable wind-up) | ai |
| `aiFeint` | `{ fighter }` | ai |
| `enemyArrived` | `{ fighter }` (reinforcement wave entered) | encounters |
| `restPoint` | `{ room }` (deck editor offered) | encounters |
| `bossFightStart` | `{ bossId }` | encounters |

## 9. Flow & progress (UI agent: `src/game/flow.js`)

**`game.flow.progress`:**

```js
{ age: 20, deaths: 0, deathCounter: 0, chapterId: 'laundromat', chapterEntryAge: 20,
  style: 'forsaken', deck, learned: Set/array of moveIds, learn: {moveId: points},
  completedChapters: [], bestAge: {} }
```

Saved to `localStorage` (`laststance.save.v1`), with every access wrapped in try/catch.

**Aging (Sifu).**
- On the player's death: `deathCounter += 1` and `age += deathCounter`.
- If `age >= 70`, the game is over (`gameOver`): restart the chapter at `chapterEntryAge` with a fresh roster.
- Otherwise show a short aging card. Keep it quietly humorous and tied to the age: "31. Your knees file a formal complaint."
- Then call `revivePlayer()`: stand up where you fell (`getup`), full health, and the enemies keep their health.
- **Age modifiers:** damage ×(1 + (age − 20) × 0.012) and max health ×(1 − (age − 20) × 0.008). Combat reads `flow.ageDamageMult()` / `flow.ageHealthMult()`.

**Flow API:** `showTitle()`, `quickStart()`, `startChapter(id)`, `revivePlayer()`, `completeChapter()`, `ageDamageMult()`, `ageHealthMult()`, `chapterId`.

**Chapter flow:**
1. A story card, written as short serious lines plus one dry joke.
2. `world.loadChapter(id)`.
3. Spawn the player at `layout.playerStart`.
4. `encounters.startChapter(id, layout)`.
5. Play through the rooms to the boss.
6. Boss intro dialogue, then the fight.
7. On `bossDefeated`: victory card, `completeChapter()`, next chapter.
8. After the final chapter: the epilogue.

**Rest points:** the deck editor is available between rooms, at the gate after a room is cleared ("Press Back to edit your deck").

## 10. World, Camera, FX, Audio

**World (WORLD agent: `src/world/*`).**
- `loadChapter(id)` returns `{ chapterId, playerStart: {x, z, yaw}, rooms: [Room], bounds }`. It disposes the previous chapter's geometry.
- `Room` is `{ id, index, kind: 'fight' | 'boss', center: {x, z}, radius, spawns: [{x, z}], entry: {x, z}, gate: {x, z, yaw} }`. Each room is an arena (about 9–14 m across), connected by short corridors. There are 3 fight rooms and 1 boss arena per chapter, laid out along a path.
- `clampPosition(pos, radius)` keeps fighters inside walkable space: room discs / rectangles + corridors, with gates blocking when closed.
- `setGate(roomId, open)`: an animated gate / screen / shutter.
- `roomAt(pos)` returns the room or null.
- `isWalkable(x, z)`.
- **Visuals:** beautiful, light, low-poly, flat or soft-shaded.
  - Palettes per chapter as in `data/chapters.js`.
  - A gradient sky dome (simple shader).
  - **No fog**, no particles, no post-processing.
  - One directional sun with soft shadows (shadow camera tightly around the active room) plus a hemisphere light.
  - Props merged per room.
  - Keep draw calls low: about 60 at most for the environment.

**Camera (WORLD agent: `src/camera/camera.js`, system `cameraRig`).**
- **Locked on (Absolver):** the camera stays behind the player's shoulder, framing the player and the target, with a slight offset to the side. It is damped, and re-centres smoothly when the target changes.
- **Unlocked:** an orbit camera on the right stick (`settings.cameraSensitivity`, `invertY`).
- Camera collision against arena walls is simple: keep the camera within room bounds + margin.
- `shake(amount 0..1)`, `punch(dir)` (a tiny directional kick on heavy hits), `cinematic(targetPos, duration)` (boss intros), `yaw` (used by PlayerController for camera-relative movement).
- Respect `settings.screenShake`.

**FX (FEEL agent: `src/fx/*`, system `fx`).** Subtle, Absolver-like.
- `trail(fighter, limb, duration)`: a short tapered ribbon following the strike point during active frames. It is pale white with a hint of the fighter's accent colour, additive, and fades in about 0.12 s.
- `hit(point, dir, heavy)`: a 2–3 frame white flash disc plus 4–10 tiny angular shards along `dir`. Heavy hits get a ring.
- `block(point)`: a small grey-blue spark.
- `parry(point)`: a crisp bright flash, a short time-scale dip, and a thin ring.
- `absorb(point)`: an inward jade pulse.
- `focus(fighter)`: a subtle screen-edge vignette pulse via a DOM overlay, never a post-processing pass.
- `death(fighter)`: a brief desaturation-free fade of the mask colour.
- Pooled meshes, ≤ 8 draw calls total.
- FX listens to the combat events itself. Combat does not need to call it, but may.

**Audio (FEEL agent: `src/audio/*`, system `audio`, `runWhenPaused`).**
- WebAudio, fully synthesised.
- `unlock()` on the first gesture.
- `play(name, { position, volume, pitch })`.
- **Sounds:** `whoosh_light, whoosh_heavy, hit_light, hit_heavy, hit_body, hit_face, block, guard_break, parry, absorb, avoid, dodge, step, land, knockdown, stance, focus_in, focus_out, death, ui_move, ui_select, ui_back, learned, gate, boss_sting, age_up, victory`.
- **Music:** a minimal, tense percussion and plucked-string loop per chapter, ducking during dialogue. The boss fight adds layers. Volume follows `settings.music`.
- Listens to combat events for automatic hit / block / whoosh sounds.

## 11. AI & Encounters (AI agent: `src/ai/*`, `src/levels/*`)

**`AI` (system `game.ai`).**
- `attach(fighter, archetype)` attaches a brain that writes `fighter.intent` each sim step.
- **Archetypes:**
  - `thug`: slow, readable, blocks a little.
  - `brawler`: heavy hitter, uses guard.
  - `swift`: fast strings, dodges.
  - `heavy`: absorb style, break moves.
  - `tadao`, `madame_shu`, `brick`, `mr_golden`: bosses with 2 phases. Phase 2 starts at 50% health with a short dialogue line and new patterns. Bosses use their signature moves.
- **Crowd director (Sifu):** at most **2 enemies attack at once** (attack tokens). Others circle at 3–5 m, feint, and taunt.
- **Reactions:** chance-based block / parry / avoid scaled by archetype and chapter, punishing whiffs, respecting stamina, and spacing to their move reach.
- **Fairness:** a short telegraph before every attack, plus a reaction delay of 0.15–0.35 s.

**`Encounters` (system `game.encounters`).**
- `startChapter(chapterId, layout)` and `getRoster(chapterId)`.
- Per room:
  1. Wait for the player to enter the room radius.
  2. Close the gates and spawn waves (e.g. 2 + 2 + 1) with looks / decks / archetypes.
  3. On clear: open the gate, emit `roomCleared`, and offer the rest point.
- **Boss room:** close the gates, emit `bossIntro` with dialogue lines, run the camera cinematic, then fight. Death → `bossDefeated`.
- `reset()` for retries.
- **Dialogue:** dry, short, in character. The boss intros are the game's signature humour.

## 12. File ownership

| Agent | Owns |
|---|---|
| core (orchestrator) | `src/main.js`, `src/core/*`, `src/anim/rig.js`, `src/data/*`, `src/index.html`, `tools/*`, `FIGHTER.md` |
| ANIM | `src/anim/*` except `rig.js` |
| MOVES | `src/combat/moves/*` |
| COMBAT | `src/combat/*` except `moves/` |
| AI | `src/ai/*`, `src/levels/*` |
| WORLD | `src/world/*`, `src/camera/*` |
| FEEL | `src/fx/*`, `src/audio/*` |
| UI | `src/ui/*`, `src/game/*` |

## 13. Build & test (run inside `fighter/`)

- `node tools/check.mjs`: syntax plus a full bundle.
- `node tools/build.mjs` produces `dist/index.html` (shippable) and `dist/artifact.html`. `--dev` produces `dist/dev.html`.
- `node tools/smoke.mjs --tag <agent> [--seconds 6] [--scenario file.mjs] [--size 960x540] [--params "chapter=market&style=windfall"] [--keep-going]` boots headless Chromium with `?autostart=1` and prints JSON (pageErrors, consoleErrors, stats, scenario result).
  - **Scenario module:** `export default async ({ page, game, keys, wait, shot, log, gameWait, hold }) => result`.
    - `game(fn, arg)` evaluates `fn(window.game, arg)` in the page.
    - `gameWait(sec)` waits SIMULATED seconds (headless runs slowly; always measure in game time).
    - `hold('light', 0.1)` holds a virtual action for 0.1 simulated seconds (a press). Virtual input API: `game.input.setVirtual(action, bool)`, `setVirtualMove(x, y)`, `setVirtualLook(x, y)`, `virtualStance('BR')`. For deterministic AI-free tests you can also drive fighters through `fighter.intent` or `game.debug` helpers.
  - Screenshots go to `.smoke/<tag>/`. LOOK at them.
- Pose QA: the ANIM and MOVES agents should add `game.debug.posePreview(trackOrMoveId, times[])`, which lays out ghost copies of a fighter at several key times in a row so one screenshot shows the whole move.
