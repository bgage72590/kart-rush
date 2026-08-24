# Kart Rush

**Play it: <https://bgage72590.github.io/kart-rush/>**

A Mario Kart–style 3D racing game that runs entirely in the browser. No build
step, no assets — every model, texture, track, and sound is generated in code
(three.js r170, vendored locally).

## Run it

```bash
python3 -m http.server 8123 --directory "$(dirname "$0")"
```

then open <http://localhost:8123>. (ES modules need a server — double-clicking
`index.html` won't work.)

## What's in the box

- **5 tracks**: Sunset Circuit, Coconut Bay, Volcano Rush (lava pools +
  geysers), Frostbite Falls (ice patches + smashable snowmen), Neon Ridge
  (night, glowing edges). All procedurally built from spline control points
  with rolling elevation.
- **Track Lab**: an in-game editor — drag control points on a map,
  double-click to add/remove them, pick a theme and hill level, hit RACE IT.
  Your track appears in the TRACK list and saves automatically.
- **Daily Challenge**: a new track generated from today's date, same for
  every player, with its own best-lap record.
- **8 characters** with weight classes that change top speed, acceleration,
  handling, and shoving power: Dash, Torque, Whiskers, Bones, Nana Nitro,
  Zorb, Quackers, Big Ceez.
- **10 items**: mushroom, banana, green/red shells, star, shield bubble, oil
  slick, EMP pulse, comet strike (hits the leader), grappling hook (slingshot
  past the kart ahead).
- **3 modes**: Single Race, Grand Prix (5-race cup with points, standings, and
  a podium ceremony), Time Trial (race your own ghost).
- **Progression**: coins on the track + race payouts fund garage upgrades
  (engine/tires/spoiler, each visible on the kart) and paint jobs.
- Drifting with two-tier mini-turbos, jump ramps with air tricks, boost pads,
  a rubber-banded rival who hunts you, skid marks, synthesized engine/SFX and
  a chiptune loop that speeds up on the final lap.
- **Rocket starts** (rev on the last countdown beat — hold too long and you
  bog down) and **slipstreaming** behind a rival for a surge.

## Controls

| Key | Action |
| --- | --- |
| ↑ / W | accelerate |
| ↓ / S | brake / reverse |
| ← → / A D | steer |
| Shift / X | hop + drift (hold through a corner, release for boost) |
| Space / Z | use item (press mid-air for a trick) |
| C | look behind |
| Esc / P | pause |
| R | restart race |
| M | mute |

Gamepads work too (stick + A/B/triggers, bumpers to drift).

## Code map

| File | Role |
| --- | --- |
| `js/config.js` | tuning constants, tracks, characters, modes |
| `js/track.js` | procedural track builder (spline → heightfield → meshes) |
| `js/tracklab.js` | track list, daily-challenge generator, custom persistence |
| `js/editor.js` | Track Lab canvas (drag points, live road preview) |
| `js/race.js` | physics, drifting, items, AI, laps, ghosts, GP points |
| `js/kart.js` | procedural kart + character models |
| `js/hud.js` | DOM HUD, menus, garage, results, podium |
| `js/fx.js` | particle pools, skid marks, blob shadows |
| `js/audio.js` | WebAudio synth: engine, SFX, music |
| `js/garage.js` | wallet, parts, paint (localStorage) |
| `js/main.js` | renderer, camera, state machine, main loop |

Saved data (best laps, ghosts, coins, parts) lives in `localStorage` under
`kartrush2.*`.
