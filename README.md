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

## Touch

Touch controls arm themselves on the first touch and disappear again on the
first key press, so a laptop with a touchscreen never gets a permanent overlay.

| Control | Where |
| --- | --- |
| steer | drag anywhere in the lower-left; the stick appears under your thumb |
| DRIFT | big gold button, bottom right |
| ITEM | above DRIFT |
| BRAKE | left of DRIFT |
| AUTO / MANUAL | pill above the cluster — auto-accelerate is the default so the right thumb stays free; tapping it swaps in a GAS pedal |
| REV | the gas slot during the countdown, for the rocket start |
| look behind / pause | the two small buttons on the right edge |

Menus, the garage, Track Lab and the results and podium screens are all
tappable, with visible BACK / RACE AGAIN / CONTINUE buttons rather than
keyboard-only exits. In Track Lab, double-*tap* adds and removes control points.

Portrait plays, and the camera widens to give back some of the view a narrow
window crops, but the track reads far better across the long edge — the game
says so once, then stops nagging.

## YouTube Playables

The game is wired for Playables and runs identically without it — the SDK is
loaded from youtube.com and deliberately no-ops anywhere else, and every call
through `js/playables.js` is guarded.

- **Lifecycle** — `gameReady` / `firstFrameReady` so the host can drop its
  loading UI.
- **Pause / resume** — YouTube freezes a Playable when it is backgrounded or
  covered by its own UI. A pause the *player* opened is theirs, though: a host
  resume will not yank them out of it.
- **Audio policy** — YouTube can disallow sound entirely. That is a separate
  gate from the player's own mute; either one silences the game.
- **Cloud save** — the whole `kartrush2.*` namespace is mirrored to the account
  save, so coins, parts, best laps, ghosts and your custom track follow you to
  another device. localStorage stays the synchronous working store; writes are
  debounced into one upload and flushed immediately on a host pause. Hydration
  runs before any module reads its slice, with a timeout — a slow or broken
  cloud never holds the game hostage — and keys outside the namespace are
  refused in both directions.
- **Rewarded ads** — one offer, in the garage: coins for a watched ad, on a
  three-minute cooldown that is persisted (so reloading is not a way to skip
  the wait) and clamped (so a corrupt timestamp cannot lock anyone out). Only
  `AdResult.SHOWED` pays; dismissing or rejecting earns nothing and does not
  burn the cooldown. The button only appears inside a real Playable, because a
  button that cannot serve an ad is worse than no button. Nothing is gated
  behind it — every part is still reachable by racing.
- **Interstitials** — the call site exists and is guarded, but nothing calls
  it. A kart race is a 45-90 second loop and an ad after every one would be
  hostile.

Revenue sharing is an invite-only pilot, so none of this earns anything yet.

## Look

Everything below is either baked once when a track is built, or folded into a
pass that was already running. The renderer is fill-rate bound, so per-pixel
work is the expensive kind and geometry and vertex colours are nearly free.

Baked at build time, free every frame after that:

- a painted 512x512 sky with themed cloud banks and a horizon glow, in place of
  the 4px gradient that used to be stretched around the dome
- ambient occlusion in the scenery's vertex colours, so trees and pylons sit on
  the ground instead of hovering
- distance haze in those same vertex colours — the depth cue camera-distance
  fog cannot give
- a polished racing line, edge grit and patch repairs in the road texture
- roadside dirt that fades out into clean grass, read off the heightfield's own
  splat weights
- kerbs that run hotter through the tight corners
- guard rails on the corners, flag poles around the lap, and pockets of crowd —
  all merged into one extra draw call

Folded into the existing grade pass, which already touches every pixel:

- a speed smear and closing vignette while boosting
- a flash on impact
- a colour push on the final lap, to match the music already speeding up
- heat haze on the lava tracks

The extra texture taps sit behind `if (uniform > 0.0)`. A branch on a uniform is
coherent across the whole draw, so that cost is only paid while the effect is on
screen.

The ten item icons are drawn into offscreen bitmaps at boot and blitted from
then on, so detail there is free at runtime. They rasterise at device
resolution — at 76px on a 3x phone the old bitmaps were being upscaled into
mush — and the slot lights up while something is actually loaded, so a glance
at the edge of the screen tells you whether you have a weapon.

And in motion: karts lean harder as the mini-turbo charges, dip their nose under
braking, and squash on landing. Wheel spin is capped below the rate that aliases
into a backwards-strobe at 60Hz, with a blurred tyre above it.

## Performance

Render resolution adapts: touch devices start at 1.5x device pixels instead of
2x, sustained slow frames step the scale down toward 1x, and a sustained
comfortable stretch earns it back. Hysteresis and a cooldown on both sides keep
it from oscillating.

## Code map

| File | Role |
| --- | --- |
| `js/boot.js` | entry point: hydrates the cloud save, then imports the game |
| `js/config.js` | tuning constants, tracks, characters, modes |
| `js/track.js` | procedural track builder (spline → heightfield → meshes) |
| `js/tracklab.js` | track list, daily-challenge generator, custom persistence |
| `js/editor.js` | Track Lab canvas (drag points, live road preview) |
| `js/race.js` | physics, drifting, items, AI, laps, ghosts, GP points |
| `js/kart.js` | procedural kart + character models |
| `js/hud.js` | DOM HUD, menus, garage, results, podium |
| `js/fx.js` | particle pools, skid marks, blob shadows |
| `js/audio.js` | WebAudio synth: engine, SFX, music |
| `js/garage.js` | wallet, parts, paint |
| `js/store.js` | save data: localStorage + debounced cloud mirror |
| `js/playables.js` | YouTube Playables SDK bridge (no-ops off YouTube) |
| `js/touch.js` | on-screen controls, auto-accelerate, touch-mode arming |
| `js/main.js` | renderer, camera, state machine, main loop, adaptive resolution |

Saved data (best laps, ghosts, coins, parts, the auto-accelerate preference)
lives in `localStorage` under `kartrush2.*`.

## Testing

`window.__kr` exposes the game state plus a `tick(ms)` hook that pumps one
frame by hand, so a whole race can be simulated deterministically from the
console without waiting on `requestAnimationFrame`:

```js
__kr.G.auto = true;                    // autopilot drives the player
__kr.attachTrack(0); __kr.doStartRace();
while (__kr.G.state !== 'RESULTS') __kr.tick(1000 / 25);
__kr.G.racers.map((r) => [r.name, r.place, r.bestLap]);
```
