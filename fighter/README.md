# Last Stance

A martial-arts revenge brawler for the browser, built for a controller.

- **Structure (Sifu):** four chapters of room fights, each ending in a boss.
- **Combat (Absolver):** four stances and a combat deck where every attack flows into the next.
- **The talisman:** it revives you every time you die, a little older each time.

Everything is generated in code: the fighters, the poses, the environments and all of the sound. It ships as one HTML file of about 1 MB.

## Play

- Open `dist/index.html` in Chrome or Edge and plug in a controller. Xbox and PlayStation pads are both detected and get the right button glyphs. Keyboard and mouse also work.
- Embedded pages (for example inside another site's iframe) may block controller access. If the pad is ignored there, open `dist/index.html` directly.

## Controls

| | Controller (Xbox / PlayStation) | Keyboard / mouse |
|---|---|---|
| Main attack (string) | X / □ | Left click, J |
| Alternate attack | Y / △ | Right click, K |
| Guard (tap during your wind-up = feint) | RB / R1 | Shift |
| Dodge | A / ✕ | Space |
| Style ability: parry / absorb / avoid | B / ○ | E |
| Lock-on | LB / L1 | Q, Tab |
| Switch stance | hold RT / R2 + flick the right stick | 1–4 |
| Focus attack | LT / L2 (+ X or Y) | F |
| Switch target | click the right stick, or flick it | T |
| Combat deck (at rest points) | View / Share | I |
| Pause | Menu / Options | Esc |

## How the combat works

- **Stances.** There are four: front right, front left, back right and back left. Every attack starts in one stance and ends in another.
- **Deck.** Your deck has 8 slots: one main and one alternate attack per stance. Pressing an attack uses the slot of the stance you are in, so the moves you equip decide where your strings travel.
- **Strings and chaining.** A string is up to three attacks. Chained attacks skip the previous move's recovery: the strike holds for a moment, then the next move blends in quickly, part-way into its wind-up. Strings are fast but readable.
- **Stamina.** Attacking, guarding and dodging all cost stamina. An empty bar leaves you open.
- **Styles.** Pick one defensive style: **Forsaken** (timed parry), **Kahlt** (absorb hits and heal on the counter) or **Windfall** (duck and side-step strikes).
- **Learning.** Defend against an enemy move enough times and you learn it.
- **Focus.** It fills as you fight. Spend it on a fast unblockable strike or a knockdown sweep.
- **Aging.** Each death ages you. Older means stronger blows and less health. At 70, the chapter starts over.

## Develop

Run from this folder (the repository root holds `node_modules`):

```
node tools/build.mjs          # dist/index.html + dist/artifact.html
node tools/build.mjs --dev    # dist/dev.html (unminified)
node tools/check.mjs          # syntax + bundle check
node tools/smoke.mjs --tag me --scenario tools/scenarios/playtest.mjs --keep-going   # headless play-test
```

`FIGHTER.md` is the module contract. It covers the fixed 120 Hz simulation, input, the rig and pose format, the move schema and chaining rules (§6b), combat, events, and every system's API.
