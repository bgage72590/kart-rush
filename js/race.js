// ---------------------------------------------------------------------------
// Race logic: kart physics, drifting, items, AI, lap/place tracking, camera.
// stepRace() is pure logic (no rendering); syncVisuals() moves the meshes.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CFG, CHARACTERS, charStats, CLASSES, TRACK_DEFS, GP_POINTS } from './config.js';
import { TAU, clamp, lerp, angNorm } from './util.js';
import { readControls, itemPressed, revving } from './input.js';
import { Sound } from './audio.js';
import { KartVisual } from './kart.js';
import { ParticlePool, SkidMarks, softDotTexture } from './fx.js';
import { Garage } from './garage.js';
import * as Store from './store.js';

// --- adaptive field pace -------------------------------------------------------
// One fixed AI pace cannot fit somebody's first race and their fiftieth, and
// picking a number that suits both is not a thing that exists. So the field
// measures the player instead.
//
// At every lap the player completes, compare how far they have come with how
// far the leading rival has, and nudge the field toward matching. Distance
// covered in the same elapsed time is a speed ratio directly, which means this
// works from the end of lap one — waiting for the AI to post a comparable lap
// time would not, because a player who is running away has not let it.
//
// Kept per engine class, because a lap time only means something next to the
// speed it was set at, and remembered, so the next race starts calibrated
// rather than starting the argument over. Clamped hard at both ends so neither
// one scrappy lap nor one blinding one can run away with the difficulty.
// The floor has to go low enough to give a genuinely slow player a race: at
// 0.80 a struggling driver still lost by most of a minute with the dial already
// on its stop, which is the same failure as the walkover, just pointed the
// other way.
const PACE_MIN = 0.60, PACE_MAX = 1.75;
const PACE_GAIN = 0.5;          // share of the measured gap closed per lap
const PACE_KEY = 'kartrush2.pace.';

function loadPace() {
  const v = parseFloat(Store.get(PACE_KEY + CLASSES[G.cls].id));
  G.paceScale = isFinite(v) ? clamp(v, PACE_MIN, PACE_MAX) : 1;
}

function calibratePace() {
  if (G.mode === 2) return;                     // a time trial has no field
  const n = G.track.wps.length;
  const covered = (r) => (r.rank || 0) - n;     // rank starts a lap in
  const mine = covered(G.racers[0]);
  let lead = 0;
  for (const r of G.racers) {
    if (r.isPlayer) continue;
    const c = covered(r);
    if (c > lead) lead = c;
  }
  if (mine <= 0 || lead <= 0) return;
  const ratio = clamp(mine / lead, 0.75, 1.5);
  G.paceScale = clamp(G.paceScale * Math.pow(ratio, PACE_GAIN), PACE_MIN, PACE_MAX);
  Store.set(PACE_KEY + CLASSES[G.cls].id, G.paceScale.toFixed(3));
}

// How much of a pace adjustment reaches the AI's straight-line speed cap. The
// rest of it goes into corner commitment, which is where the AI actually loses
// time and where going faster reads as skill rather than as a cheat.
const TOP_SHARE = 0.35;

// A shell's own half-width, so it ricochets off the face of the barrier rather
// than from wherever its centre happens to be.
const SHELL_RADIUS = 1.2;

// CFG values that scale with the engine class: speeds, and distances that
// should preserve the same time window at any speed. Declared once, so adding
// a scaled constant is a CFG entry plus a name here.
const SCALED = [
  'topSpeed', 'accel', 'brake', 'revSpeed', 'shellSpeed', 'rampMin',
  'rescueSpeed', 'wrongWayMin', 'grappleRange', 'airLaunch', 'geyserLaunch',
  'steerPower',
];

// Everything the handling model measures against top speed is already written
// as a ratio — steering authority, drift entry and exit, slipstream range — so
// scaling these preserves the character of the driving and changes only how
// much time you get to use it.
//
// The derived thresholds are precomputed rather than recomputed in the physics
// loop. CFG is a module constant an engine can fold into an immediate; G.tune
// is reassigned every race and cannot be, so leaving `top * 0.4` inline would
// mean thousands of loads and multiplies a second for six fixed numbers.
function makeTune(cls) {
  const k = cls.speed;
  const t = { skill: cls.skill, band: cls.band, corner: cls.corner };
  for (const key of SCALED) {
    const base = CFG[key];
    // A renamed or misspelled key would otherwise yield NaN and poison every
    // threshold derived below it, with nothing thrown and nothing logged.
    if (!isFinite(base)) throw new Error('CFG.' + key + ' is missing or not a number');
    t[key] = base * k;
  }

  // Gravity scales with the *square* of class speed so a jump keeps its shape.
  // Hang time then falls as 1/k while ground speed rises as k, which lands
  // every class at the same distance and the same height — track geometry does
  // not scale, so the jump must not either. Left linear, a 52% speed increase
  // stretched jumps 97% and threw 150cc karts clean past the corner.
  // `steerPower` is an angular rate, which is why it is easy to miss here, but
  // it is linear in k for the same reason the speeds are. Turn radius is
  // speed / turn-rate; leaving the rate fixed while speed scales by k makes the
  // radius scale by k, on a track whose corners are exactly the same size.
  // Measured before this was scaled: a minimum radius of 33.9 / 42.4 / 51.7
  // units at 50 / 100 / 150cc against a tightest corner of 26.1, so at 150cc
  // the kart could not physically follow the corner — you steered, ran wide,
  // and hit the wall. Scaling the rate by k cancels k out of speed / rate, so
  // every class holds the same line and the class decides only how fast it
  // arrives, which is what an engine class is supposed to mean.
  t.gravity = CFG.gravity * k * k;
  // ...and the barrel roll has to finish inside that shorter hang time.
  t.trickSpin = CFG.trickSpin / k;

  const top = t.topSpeed;
  t.driftEntry = top * 0.4;     // fast enough to break into a drift
  t.driftDrop = top * 0.25;     // too slow to hold one
  t.steerRef = top * 0.32;      // speed at which steering reaches full authority
  t.draftGate = top * 0.55;     // fast enough to be slipstreaming
  t.draftMin = top * 0.5;       // the kart ahead must be going at least this fast
  t.aiDriftGate = top * 0.55;   // AI will not attempt a drift below this
  t.grapplePull = top * 1.45;
  return t;
}

// The class and the tuning derived from it must never disagree, so the class is
// a property with a setter rather than a field anyone can write past. Assigning
// G.cls rebuilds G.tune; there is no other way to change either, which is what
// a plain field plus a setClass() helper could never actually guarantee.
let clsIndex = 1;

// The selected class, for callers that want its name or id rather than its
// physics.
export const curClass = () => CLASSES[clsIndex];

export const G = {
  state: 'MENU',            // MENU | CHARSEL | COUNTDOWN | RACE | PAUSE | RESULTS
  trackIndex: 0,
  get cls() { return clsIndex; },
  set cls(v) {
    clsIndex = clamp(v | 0, 0, CLASSES.length - 1);
    this.tune = makeTune(CLASSES[clsIndex]);
  },
  tune: null,               // built through the setter immediately below
  playerChar: 0,
  rivalId: -1,
  paceScale: 1,             // adaptive field pace, calibrated to this player
  prevPlayerPlace: 6,
  tauntCd: 0,
  mode: 0,                  // 0 single race, 1 grand prix, 2 time trial
  gp: null,                 // { race, cast, points[6] }
  startGasTime: 0,          // how long the player has held gas during countdown
  ghostBest: null,          // loaded best run for the current TT track
  ghostRec: null,           // samples being recorded this TT run
  ghostAcc: 0,
  track: null,
  racers: [],
  bananas: [],
  shells: [],
  oils: [],
  comets: [],
  rings: [],                // expanding shockwave visuals
  grapples: [],             // active grapple lines
  time: 0,
  countdown: 0,
  cam: { x: 0, z: 0, angle: 0, shake: 0 },
  msg: null, msgTime: 0,
  results: null,
  auto: false,              // autopilot for the player (used by tests/attract)
};

G.cls = clsIndex;           // derive the initial tune through the setter

let scene = null;
let visuals = [];
let sparkPool = null, dustPool = null, glowPool = null;
let skids = null;

// shared item-mesh resources
const shellGeo = new THREE.SphereGeometry(0.85, 14, 10);
const rimGeo = new THREE.TorusGeometry(0.86, 0.2, 8, 18).rotateX(Math.PI / 2);
const shellMats = {
  green: new THREE.MeshStandardMaterial({ color: 0x3fa84f, roughness: 0.4 }),
  red: new THREE.MeshStandardMaterial({ color: 0xd63b34, roughness: 0.4 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xf2ecd8, roughness: 0.6 }),
};
const bananaMat = new THREE.MeshStandardMaterial({ color: 0xf2d23d, roughness: 0.6 });
const bananaTip = new THREE.MeshStandardMaterial({ color: 0x6b5410, roughness: 0.8 });
const bananaGeo = new THREE.SphereGeometry(0.34, 8, 6);

export function initRace(sceneRef) {
  scene = sceneRef;
  visuals = CHARACTERS.map((c) => new KartVisual(c.palette, c.head));
  sparkPool = new ParticlePool(scene, 350, { size: 0.85, additive: true, gravity: -20 });
  glowPool = new ParticlePool(scene, 250, { size: 1.15, additive: true, gravity: -2 });
  dustPool = new ParticlePool(scene, 300, { size: 2.2, additive: false, gravity: -6 });
  skids = new SkidMarks(scene, 800);
}

// --- time-trial ghost --------------------------------------------------------

let ghostVis = null;
let ghostVisChar = -1;
let ghostHint = 0;

// One ghost body per character, built on demand and kept for reuse — rebuilding
// a KartVisual every time-trial start leaked ~40 geometries a run.
const ghostCache = {};

function makeGhostVisual(charIdx) {
  if (ghostVis && ghostVisChar === charIdx) {
    ghostVis.addTo(scene);
    ghostVis.shadow.visible = false;
    ghostHint = 0;
    return;
  }
  cleanupGhost();
  if (!ghostCache[charIdx]) {
    const ch = CHARACTERS[charIdx];
    const v = new KartVisual(ch.palette, ch.head);
    for (const k in v.mats) {
      v.mats[k].transparent = true;
      v.mats[k].opacity = 0.32;
      v.mats[k].depthWrite = false;
    }
    ghostCache[charIdx] = v;
  }
  ghostVis = ghostCache[charIdx];
  ghostVisChar = charIdx;
  ghostVis.shadow.visible = false;
  ghostVis.addTo(scene);
  ghostHint = 0;
}

function cleanupGhost() {
  if (ghostVis) {
    ghostVis.removeFrom(scene);
    ghostVis = null;
    ghostVisChar = -1;
  }
}
export { cleanupGhost };

function updateGhostPlayback() {
  if (!ghostVis || !G.ghostBest || G.state !== 'RACE') {
    if (ghostVis) ghostVis.group.visible = false;
    return;
  }
  const s = G.ghostBest.s;
  const f = G.time / 0.1;
  const i0 = Math.floor(f), frac = f - i0;
  const b = i0 * 3;
  if (b + 5 >= s.length) { ghostVis.group.visible = false; return; }
  ghostVis.group.visible = true;
  const x = lerp(s[b], s[b + 3], frac);
  const z = lerp(s[b + 1], s[b + 4], frac);
  const yaw = s[b + 2] + angNorm(s[b + 5] - s[b + 2]) * frac;
  const q = G.track.query(x, z, ghostHint);
  ghostHint = q.sIdx;
  ghostVis.group.position.set(x, q.groundY, z);
  ghostVis.group.rotation.y = -yaw;
}

function saveGhost(total) {
  if (!G.ghostRec || G.ghostRec.length < 10) return false;
  if (G.ghostBest && G.ghostBest.total <= total) return false;
  const data = { total, charIdx: G.playerChar, s: G.ghostRec };
  Store.set('kartrush2.ghost.' + recordKey(G.track.def), JSON.stringify(data));
  return true;
}

// Judge the rocket-start rev held through the countdown (called at GO).
export function resolveRocketStart() {
  const p = G.racers[0];
  const t = G.startGasTime;
  G.startGasTime = 0;
  if (!p || G.auto) return;
  if (t > 0.05 && t <= 0.85) {
    p.boost = Math.max(p.boost, 1.25);
    showMsg('ROCKET START!', 1.4);
    Sound.boost();
  } else if (t > 1.9) {
    p.stall = 0.85;
    p.speed = 0;
    showMsg('WHEELSPIN!', 1.4);
    Sound.noiseBurst(0.5, 200, 0.3);
  }
  // give the AI a spread of starts too
  for (const r of G.racers) {
    if (r.isPlayer || r.finished) continue;
    const roll = Math.random();
    if (roll < 0.25) r.boost = Math.max(r.boost, 0.9);
    else if (roll > 0.93) r.stall = 0.6;
  }
}

// Award cup points for the current standings. Safe to call repeatedly while
// stragglers are still crossing the line: the previous payout for this race is
// retracted first, so the table and the standings can never disagree.
export function awardGpPoints() {
  if (!G.gp) return;
  if (G.gp.lastAward) {
    for (let i = 0; i < G.gp.lastAward.length; i++) G.gp.points[i] -= G.gp.lastAward[i];
  } else {
    G.gp.race++;
  }
  G.gp.lastAward = G.gp.points.map(() => 0);
  for (const r of G.racers) {
    const pts = GP_POINTS[r.place - 1] || 0;
    G.gp.points[r.id] += pts;
    G.gp.lastAward[r.id] = pts;
  }
}

export function confettiBurst(x, y, z, n) {
  for (let i = 0; i < n; i++) {
    const c = new THREE.Color().setHSL(Math.random(), 0.9, 0.6);
    glowPool.emit(
      x + (Math.random() - 0.5) * 26, y + Math.random() * 6, z + (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 6, -2 - Math.random() * 3, (Math.random() - 0.5) * 6,
      1.6, c.r, c.g, c.b);
  }
}

function makeShellMesh(kind) {
  const g = new THREE.Group();
  const s = new THREE.Mesh(shellGeo, shellMats[kind]);
  s.scale.y = 0.78;
  const r = new THREE.Mesh(rimGeo, shellMats.rim);
  r.scale.y = 0.5;
  g.add(s); g.add(r);
  return g;
}

function makeBananaMesh() {
  const g = new THREE.Group();
  const positions = [[-0.35, 0.28], [0, 0.42], [0.35, 0.28]];
  for (const [x, y] of positions) {
    const m = new THREE.Mesh(bananaGeo, bananaMat);
    m.position.set(x, y, 0);
    g.add(m);
  }
  const tip = new THREE.Mesh(bananaGeo, bananaTip);
  tip.position.set(0.55, 0.22, 0);
  tip.scale.set(0.5, 0.5, 0.5);
  g.add(tip);
  return g;
}

// --- racer setup -------------------------------------------------------------

function makeRacer(id, charIdx, isPlayer, track, gridSlot) {
  const row = Math.floor(gridSlot / 2), col = (gridSlot % 2) ? 1 : -1;
  const back = 13 + row * 7.5;
  const sIdx = ((track.N - Math.round(back / track.spacing)) % track.N + track.N) % track.N;
  const s = track.samples[sIdx];
  const lat = col * 4.6;
  const ch = CHARACTERS[charIdx];
  return {
    id, charIdx, name: ch.name, isPlayer,
    stats: charStats(ch), voice: ch.voice,
    mods: { top: 1, steer: 1, grass: CFG.grassFactor, drift: 1, tiers: null, paint: -1 },
    x: s.x + (-s.tz) * lat,
    z: s.z + s.tx * lat,
    angle: Math.atan2(s.tz, s.tx),
    speed: 0,
    drift: 0, driftCharge: 0, hop: 0, driftReady: false, hopZ: 0,
    spin: 0, boost: 0, star: 0, respawn: 0, boostPadCd: 0, forceRescue: 0,
    shield: false, slip: 0, stall: 0, onIce: false,
    airY: 0, airV: 0, airW: 0, tricked: false, trickT: -1, trickDur: CFG.trickSpin, prevAirDrift: false,
    grapple: null,
    item: null, itemRoll: 0, rollIcon: 0, pendingItem: null,
    lap: 1, wpIdx: 0, progress: 0, place: gridSlot + 1, rank: 0,
    finished: false, finishTime: null,
    lapStart: 0, bestLap: null, lastLap: null,
    wrongWay: false,
    visYaw: Math.atan2(s.tz, s.tx),
    sHint: sIdx,
    groundY: s.y + CFG.roadLift,
    pitch: 0, roll: 0, steerVis: 0,
    offTrack: 0,
    wallOut: -1, behindWall: false,
    q: null,
    _skidL: null, _skidR: null,
    aiGrade: 1,
    ai: {
      offset: (Math.random() * 2 - 1) * 0.5,
      nextOffset: 2 + Math.random() * 3,
      itemTimer: 1 + Math.random() * 3,
      wobble: Math.random() * TAU,
      grade: 0.9 + Math.random() * 0.2,
    },
  };
}

// Rings own a material each and grapple lines own a geometry each, so both the
// natural-expiry path and every reset path have to dispose them. Keeping that
// in one place per resource is what stops the two drifting apart again.
function killRing(rg) {
  scene.remove(rg.mesh);
  rg.mesh.material.dispose();
}

function killGrapple(gp) {
  scene.remove(gp.line);
  gp.line.geometry.dispose();
}

export function clearProjectiles() {
  if (!scene) return;                // nothing has been added to a scene yet
  for (const s of G.shells) if (s.mesh) scene.remove(s.mesh);
  for (const b of G.bananas) if (b.mesh) scene.remove(b.mesh);
  for (const o of G.oils) if (o.mesh) scene.remove(o.mesh);
  for (const c of G.comets) if (c.mesh) scene.remove(c.mesh);
  for (const rg of G.rings) if (rg.mesh) killRing(rg);
  for (const gp of G.grapples) if (gp.line) killGrapple(gp);
  G.shells = []; G.bananas = []; G.oils = []; G.comets = []; G.rings = []; G.grapples = [];
}

export function startRace(sceneRef, track, trackIndex) {
  scene = sceneRef;
  if (G.track && G.track !== track) scene.remove(G.track.group);
  if (!G.track || G.track !== track) scene.add(track.group);
  G.track = track;
  G.trackIndex = trackIndex;
  loadPace();
  clearProjectiles();
  for (const sm of track.snowmen) { sm.alive = true; sm.group.visible = true; }
  for (const box of track.itemBoxes) {
    box.cooldown = 0;
    box.group.visible = true;
    box.group.scale.set(1, 1, 1);
  }

  const timeTrial = G.mode === 2;

  // cast the race: player's pick + 5 random rivals (a GP keeps its cast)
  let cast;
  if (G.gp && G.gp.cast) cast = G.gp.cast;
  else {
    const pool = [];
    for (let c = 0; c < CHARACTERS.length; c++) if (c !== G.playerChar) pool.push(c);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    cast = [G.playerChar, ...pool.slice(0, 5)];
    if (G.gp) G.gp.cast = cast;
  }
  if (G.gp) G.gp.lastAward = null;      // fresh race: next award increments gp.race

  for (const v of visuals) v.removeFrom(scene);
  cleanupGhost();
  G.racers = [];
  const count = timeTrial ? 1 : 6;
  for (let i = 0; i < count; i++) {
    const isPlayer = i === 0;
    const slot = timeTrial ? 0 : (isPlayer ? 5 : i - 1);   // player starts at the back
    const r = makeRacer(i, cast[i], isPlayer, track, slot);
    if (isPlayer) r.mods = Garage.mods();
    r.visual = visuals[cast[i]];
    r.visual.applyMods(r.mods.tiers, r.mods.paint, CHARACTERS[r.charIdx].palette.body);
    r.visual.addTo(scene);
    G.racers.push(r);
  }
  for (const c of track.coins) {
    c.taken = timeTrial;
    c.mesh.visible = !timeTrial;
  }
  for (const box of track.itemBoxes) {
    if (timeTrial) { box.cooldown = 1e9; box.group.visible = false; }
  }
  G.coinsThisRace = 0;
  G.rivalId = timeTrial ? -1 : 1 + Math.floor(Math.random() * 5);
  G.prevPlayerPlace = 6;
  G.tauntCd = 0;

  // time-trial ghost
  G.ghostBest = null;
  G.ghostRec = timeTrial ? [] : null;
  G.ghostAcc = 0;
  if (timeTrial) {
    try {
      const d = JSON.parse(Store.get('kartrush2.ghost.' + recordKey(track.def)));
      if (d && d.s && d.s.length > 9) {
        G.ghostBest = d;
        makeGhostVisual(d.charIdx == null ? G.playerChar : d.charIdx);
      }
    } catch (e) { /* no ghost yet */ }
  }

  sparkPool.clear(); dustPool.clear(); glowPool.clear();
  skids.clear();

  G.time = 0;
  G.countdown = 3.6;
  G.state = 'COUNTDOWN';
  G.msg = null; G.msgTime = 0;
  G.results = null;
  G.startGasTime = 0;
  Sound.music.rush = false;

  const p = G.racers[0];
  G.cam.x = p.x - Math.cos(p.angle) * CFG.camDist;
  G.cam.z = p.z - Math.sin(p.angle) * CFG.camDist;
  G.cam.angle = p.angle;
  G.cam.shake = 0;
  updatePlaces();
  // prime queries/visuals so the first render is correct
  for (const r of G.racers) {
    r.q = track.query(r.x, r.z, r.sHint);
    r.sHint = r.q.sIdx;
    r.groundY = r.q.groundY;
  }
}

// --- lap / progress ------------------------------------------------------------

function nearestWp(r) {
  const wps = G.track.wps, n = wps.length;
  let best = r.wpIdx, bestD = Infinity;
  for (let k = -8; k <= 14; k++) {
    const i = ((r.wpIdx + k) % n + n) % n;
    const dx = wps[i].x - r.x, dz = wps[i].z - r.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (bestD > 90 * 90) {
    for (let i = 0; i < n; i++) {
      const dx = wps[i].x - r.x, dz = wps[i].z - r.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  return best;
}

function updateProgress(r) {
  const wps = G.track.wps, n = wps.length;
  const near = nearestWp(r);
  let delta = near - r.wpIdx;
  if (delta > n / 2) delta -= n;
  if (delta < -n / 2) delta += n;
  r.wpIdx = near;
  r.progress += delta;

  if (!r.finished && r.progress >= n) {
    r.progress -= n;
    completeLap(r);
  }
  if (r.progress < 0) {
    if (r.lap > 1) {
      // reversing back over the line: roll the lap back and restore its start
      // time so re-crossing doesn't record a bogus few-second "lap"
      r.lap--;
      r.progress += n;
      r.lapStart = r.prevLapStart != null ? r.prevLapStart : r.lapStart;
      r.lastLap = null;
    } else r.progress = Math.max(r.progress, -n * 0.25);
  }

  const w = wps[near];
  r.wrongWay = r.isPlayer &&
    (Math.cos(r.angle) * w.tx + Math.sin(r.angle) * w.tz) < -0.35 && r.speed > G.tune.wrongWayMin;
  r.rank = r.lap * n + r.progress;
}

function completeLap(r) {
  const lapTime = G.time - r.lapStart;
  r.prevLapStart = r.lapStart;
  r.lapStart = G.time;
  r.lastLap = lapTime;
  if (r.bestLap == null || lapTime < r.bestLap) r.bestLap = lapTime;
  r.lap++;
  if (r.isPlayer) calibratePace();
  if (r.lap > G.track.laps) {
    r.finished = true;
    r.finishTime = G.time;
    if (r.isPlayer) finishRace();
  } else if (r.isPlayer) {
    Sound.lap();
    const finalLap = r.lap === G.track.laps;
    if (finalLap) Sound.music.rush = true;
    showMsg(finalLap ? 'FINAL LAP!' : 'LAP ' + r.lap, 1.8);
  }
}

export function showMsg(text, dur) { G.msg = text; G.msgTime = dur; }

function updatePlaces() {
  const list = G.racers.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return (b.rank || 0) - (a.rank || 0);
  });
  list.forEach((r, i) => { r.place = i + 1; });
}

function finishRace() {
  updatePlaces();
  // project unfinished AI finish times so the results table is full
  const n = G.track.wps.length;
  for (const r of G.racers) {
    if (!r.finished) {
      const remaining = (G.track.laps + 1) * n - (r.rank || 0);
      r.projected = G.time + remaining * 0.4;
    }
  }
  G.results = G.racers.slice().sort((a, b) => a.place - b.place);
  G.state = 'RESULTS';
  const me = G.racers[0];
  if (G.mode === 2) {
    G.lastPayout = 5;
    G.newGhost = saveGhost(me.finishTime);
  } else {
    G.lastPayout = [20, 14, 10, 7, 5, 4][me.place - 1] || 4;
  }
  Garage.addCoins(G.lastPayout);
  Sound.finish(G.mode === 2 ? true : me.place <= 3);
  if (me.bestLap != null) {
    const key = 'kartrush2.best.' + recordKey(G.track.def);
    const cur = parseFloat(Store.get(key));
    if (!isFinite(cur) || me.bestLap < cur) Store.set(key, String(me.bestLap));
  }
}

// Records key off the layout, not just the display name: the custom track keeps
// the name "My Track" through every edit, so its rev has to be part of the key
// or an old ghost replays through new terrain.
export function recordKey(def, cls = G.cls) {
  const i = clamp(cls | 0, 0, CLASSES.length - 1);
  const base = def.custom ? 'My Track#' + (def.rev || 0) : def.name;
  // A 150cc lap would beat every 50cc lap forever, so a record only means
  // something within its own class. Stamped with the stable id rather than the
  // display name, so renaming a class cannot orphan every saved best and ghost.
  return base + '@' + CLASSES[i].id;
}

export function getBestByName(name) {
  const v = parseFloat(Store.get('kartrush2.best.' + name));
  return isFinite(v) ? v : null;
}

export function getBestForDef(def, cls) {
  return getBestByName(recordKey(def, cls));
}

// --- items ----------------------------------------------------------------------

function rollItem(place, total) {
  const t = (place - 1) / Math.max(1, total - 1);      // 0 = leader, 1 = last
  const table = [
    ['banana', 0.24 - t * 0.14],
    ['green', 0.22 - t * 0.10],
    ['shield', 0.11],
    ['oil', 0.10 - t * 0.04],
    ['mushroom', 0.09 + t * 0.13],
    ['red', 0.09 + t * 0.07],
    ['emp', 0.04 + t * 0.06],
    ['grapple', 0.04 + t * 0.05],
    ['comet', t > 0.35 ? 0.02 + t * 0.09 : 0],
    ['star', 0.01 + t * 0.11],
  ];
  let sum = 0;
  for (const e of table) sum += e[1];
  let x = Math.random() * sum;
  for (const e of table) { x -= e[1]; if (x <= 0) return e[0]; }
  return 'banana';
}

// Central hit resolution: stars are immune, shields absorb one hit.
function hitRacer(r, hard) {
  if (r.star > 0) return false;
  if (r.shield) {
    r.shield = false;
    if (r.isPlayer) Sound.pop();
    for (let i = 0; i < 10; i++) {
      glowPool.emit(r.x, r.groundY + 1.5, r.z,
        (Math.random() - 0.5) * 14, 4 + Math.random() * 6, (Math.random() - 0.5) * 14,
        0.4, 0.5, 0.8, 1);
    }
    return false;
  }
  spinOut(r, hard);
  return true;
}

function useItem(r) {
  if (!r.item || r.itemRoll > 0) return;
  const kind = r.item;
  r.item = null;
  const fx = Math.cos(r.angle), fz = Math.sin(r.angle);
  if (kind === 'mushroom') {
    r.boost = Math.max(r.boost, 1.5);
    if (r.isPlayer) Sound.boost();
  } else if (kind === 'banana') {
    const b = {
      x: r.x - fx * 10, z: r.z - fz * 10, owner: r.id, life: 25,
      mesh: makeBananaMesh(), groundY: r.groundY,
    };
    b.mesh.position.set(b.x, b.groundY, b.z);
    b.mesh.rotation.y = Math.random() * TAU;
    scene.add(b.mesh);
    G.bananas.push(b);
    if (r.isPlayer) Sound.throwItem();
  } else if (kind === 'green' || kind === 'red') {
    let target = null;
    if (kind === 'red') {
      let best = null;
      for (const o of G.racers) {
        if (o === r || o.finished) continue;
        if ((o.rank || 0) > (r.rank || 0) && (!best || (o.rank || 0) < (best.rank || 0))) best = o;
      }
      target = best;
    }
    const sh = {
      kind, x: r.x + fx * 12, z: r.z + fz * 12,
      angle: r.angle, speed: G.tune.shellSpeed, owner: r.id, life: 9, target,
      sHint: r.sHint, groundY: r.groundY, mesh: makeShellMesh(kind),
    };
    sh.mesh.position.set(sh.x, sh.groundY + 0.85, sh.z);
    scene.add(sh.mesh);
    G.shells.push(sh);
    if (r.isPlayer) Sound.throwItem();
  } else if (kind === 'star') {
    r.star = 6.5;
    r.boost = Math.max(r.boost, 0.6);
    if (r.isPlayer) Sound.boost();
  } else if (kind === 'shield') {
    r.shield = true;
    if (r.isPlayer) Sound.pop();
  } else if (kind === 'oil') {
    // three slick patches dropped in a trail
    for (let k = 0; k < 3; k++) {
      const d = 9 + k * 6.5;
      const o = {
        x: r.x - fx * d, z: r.z - fz * d, owner: r.id, life: 18, grace: 0.6,
        mesh: new THREE.Mesh(oilGeo, oilMat),
      };
      const q = G.track.query(o.x, o.z, r.sHint);
      o.groundY = q.groundY;
      o.mesh.rotation.x = -Math.PI / 2;
      o.mesh.position.set(o.x, o.groundY + 0.15, o.z);
      o.mesh.renderOrder = 1;
      scene.add(o.mesh);
      G.oils.push(o);
    }
    if (r.isPlayer) Sound.throwItem();
  } else if (kind === 'emp') {
    Sound.zap();
    spawnRing(r.x, r.groundY + 1, r.z, 26, 0x7fd0ff);
    for (const o of G.racers) {
      if (o === r || o.finished) continue;
      if (Math.hypot(o.x - r.x, o.z - r.z) > 26) continue;
      if (o.star > 0) continue;
      if (o.shield) { o.shield = false; continue; }
      o.item = null; o.pendingItem = null; o.itemRoll = 0;
      o.stall = 0.9;
      o.speed *= 0.45;
      o.drift = 0; o.driftCharge = 0; o.grapple = null;
    }
  } else if (kind === 'comet') {
    let target = null;
    for (const o of G.racers) {
      if (o.finished || o === r) continue;
      if (!target || o.place < target.place) target = o;
    }
    if (target) {
      const c = {
        owner: r.id, target, t: 0, dur: 2.3,
        sx: r.x, sz: r.z, sy: r.groundY + 2,
        x: r.x, z: r.z, y: r.groundY + 2,
        mesh: makeCometMesh(),
      };
      c.mesh.position.set(c.x, c.y, c.z);
      scene.add(c.mesh);
      G.comets.push(c);
      if (r.isPlayer) Sound.throwItem();
      if (target.isPlayer) showMsg('⚠ COMET INCOMING', 1.6);
    }
  } else if (kind === 'grapple') {
    // latch onto a kart ahead and slingshot past it
    let best = null, bestD = G.tune.grappleRange;
    for (const o of G.racers) {
      if (o === r || o.finished) continue;
      const dx = o.x - r.x, dz = o.z - r.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      const ang = Math.abs(angNorm(Math.atan2(dz, dx) - r.angle));
      if (ang < 0.55) { best = o; bestD = d; }
    }
    if (best) {
      const line = makeGrappleLine();
      scene.add(line);
      r.grapple = { target: best, t: 0, dur: 1.1 };
      G.grapples.push({ owner: r, target: best, line });
      Sound.hook();
    } else {
      r.boost = Math.max(r.boost, 0.35);         // consolation puff
      if (r.isPlayer) Sound.boost();
    }
  }
}

const oilGeo = new THREE.CircleGeometry(2.7, 18);
const oilMat = new THREE.MeshBasicMaterial({
  color: 0x14161e, transparent: true, opacity: 0.85, depthWrite: false,
});
const ringGeoShared = new THREE.TorusGeometry(1, 0.22, 8, 32).rotateX(Math.PI / 2);

function spawnRing(x, y, z, maxR, color) {
  const mesh = new THREE.Mesh(ringGeoShared, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.9, depthWrite: false,
  }));
  mesh.position.set(x, y, z);
  scene.add(mesh);
  G.rings.push({ mesh, t: 0, dur: 0.55, maxR });
}

// Every comet looks identical, so share one geometry + materials (the old
// per-instance versions were never disposed).
const cometGeoShared = new THREE.SphereGeometry(1.1, 12, 10);
const cometCoreMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff });
let cometGlowMat = null;

function makeCometMesh() {
  if (!cometGlowMat) {
    cometGlowMat = new THREE.SpriteMaterial({
      map: softDotTexture(), color: 0x5fb0ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(cometGeoShared, cometCoreMat));
  const glow = new THREE.Sprite(cometGlowMat);
  glow.scale.set(5, 5, 1);
  g.add(glow);
  return g;
}

function makeGrappleLine() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe14d }));
}

function spinOut(r, hard) {
  if (r.star > 0 || r.spin > 0) return;
  r.spin = hard ? 1.25 : 0.9;
  r.speed *= 0.2;
  r.drift = 0; r.driftCharge = 0; r.boost = 0;
  r.grapple = null;                 // getting hit rips the hook loose
  if (r.isPlayer) {
    Sound.hit();
    G.cam.shake = 1.4;
    if (r.item && Math.random() < 0.5) r.item = null;
  }
  for (let i = 0; i < 16; i++) {
    sparkPool.emit(
      r.x, r.groundY + 1.5, r.z,
      (Math.random() - 0.5) * 16, 6 + Math.random() * 10, (Math.random() - 0.5) * 16,
      0.7, 1, 0.85, 0.3);
  }
}

// --- physics ------------------------------------------------------------------

function driveRacer(r, c, dt) {
  const track = G.track;
  // resolved once: this runs per racer per substep, 720 times a second
  const T = G.tune, top = T.topSpeed;
  const grip = r.q && r.q.onRoad ? 1 : r.mods.grass;
  const boosting = r.boost > 0;
  const maxSpeed = top * r.stats.top * r.mods.top * grip * (boosting ? 1.55 : 1) *
    (r.star > 0 ? 1.22 : 1) * (r.isPlayer ? 1 : r.aiGrade);

  // ice patches: detect before steering so this step slides
  r.onIce = false;
  if (track.icePatches.length && r.q && r.q.onRoad) {
    for (const ip of track.icePatches) {
      const dx = r.x - ip.x, dz = r.z - ip.z;
      if (dx * dx + dz * dz < ip.r * ip.r) { r.onIce = true; break; }
    }
  }
  if (r.slip > 0) r.slip -= dt;
  if (r.stall > 0) r.stall -= dt;

  // grapple pull overrides normal driving
  if (r.grapple) {
    const gp = r.grapple;
    gp.t += dt;
    const tgt = gp.target;
    const dx = tgt.x - r.x, dz = tgt.z - r.z;
    const d = Math.hypot(dx, dz);
    r.angle = Math.atan2(dz, dx);
    r.visYaw = r.angle;
    r.speed = Math.max(r.speed, T.grapplePull);
    if (d < 5 || gp.t >= gp.dur) {
      r.grapple = null;
      r.boost = Math.max(r.boost, 0.8);
      // release with a lateral offset so we don't just rear-end the target
      r.angle += 0.28 * (Math.random() < 0.5 ? 1 : -1);
      if (r.isPlayer) Sound.boost();
    }
  }

  // Airborne: a ballistic arc in world space, no steering.
  //
  // `airW` is the kart's world height and is what gravity acts on; `airY` is
  // derived from it as height above whatever ground is currently underneath.
  // Flying the arc in world space is what makes a jump over falling ground work
  // — measured from the launch height instead, `airY` goes negative on the way
  // down into a dip, the kart drops out of this branch while still in the air,
  // and it snaps to the ground mid-flight.
  if (r.airY > 0 || r.airV > 0) {
    r.airV -= T.gravity * dt;
    r.airW += r.airV * dt;
    if (c.drift && !r.prevAirDrift && !r.tricked && r.airY > 0.4) {
      r.tricked = true;
      r.trickT = 0;
      r.trickDur = T.trickSpin;      // the visual reads this, so it scales too
      if (r.isPlayer) Sound.trick();
    }
    r.prevAirDrift = c.drift;
    if (r.trickT >= 0) r.trickT += dt;

    // Where the arc would carry us, and what is under it there.
    const ax = r.x + Math.cos(r.angle) * r.speed * dt;
    const az = r.z + Math.sin(r.angle) * r.speed * dt;
    const qa = track.query(ax, az, r.sHint);
    r.airY = r.airW - qa.groundY;

    if (r.airY <= 0 && r.airV <= 0) {
      // Touchdown is where the arc meets the ground, so the kart never snaps
      // onto it. The ground path below does the move and the query.
      r.airY = 0; r.airV = 0;
      if (r.tricked) {
        r.boost = Math.max(r.boost, 0.95);
        if (r.isPlayer) Sound.boost();
      }
      r.tricked = false;
      r.trickT = -1;
    } else {
      // fly straight; keep momentum, skip ground handling
      r.x = ax; r.z = az;
      r.q = qa;
      r.sHint = qa.sIdx;
      r.groundY = qa.groundY;            // the ground below, kept live
      // A kart clears the barrier in the air, so record where it is relative to
      // the wall without acting on it — otherwise landing outside one reads as
      // having come through it, and it gets snapped back in.
      r.wallOut = barrierOut(track, r.q);
      r.behindWall = false;              // in the air, not stranded
      r.hopZ = r.airY;
      if (r.boost > 0) r.boost -= dt;
      if (r.star > 0) r.star -= dt;
      return;
    }
  }

  if (r.spin > 0) {
    r.spin -= dt;
    r.visYaw += dt * 14;
    r.speed -= r.speed * 2.6 * dt;
  } else if (r.stall > 0) {
    r.speed -= r.speed * 3.2 * dt;
    r.visYaw = angNorm(r.visYaw + Math.sin(r.stall * 30) * dt * 2);
  } else {
    if (c.gas) r.speed += T.accel * r.stats.accel * (boosting ? 1.8 : 1) * dt;
    else r.speed -= r.speed * 0.9 * dt;
    if (c.brake) r.speed -= T.brake * dt;

    const drag = (grip < 1 ? 2.6 : 0.5) + (r.speed > maxSpeed ? 3.2 : 0);
    r.speed -= (r.speed - Math.min(r.speed, maxSpeed)) * drag * dt;
    r.speed -= r.speed * (grip < 1 ? 1.5 : (r.onIce ? 0.1 : 0.32)) * dt;
    r.speed = clamp(r.speed, -T.revSpeed, Math.max(maxSpeed, r.speed));

    const sr = r.speed / top;
    const steerPower = T.steerPower * r.stats.steer * r.mods.steer *
      (1 - 0.34 * clamp(sr, 0, 1.4)) * (grip < 1 ? 0.85 : 1) *
      (r.slip > 0 ? 0.15 : 1) * (r.onIce ? 0.35 : 1);

    if (c.drift && r.drift === 0 && r.speed > T.driftEntry) {
      if (r.hop <= 0 && !r.driftReady) { r.hop = 0.18; r.driftReady = true; }
      if (r.hop <= 0 && c.steer !== 0) { r.drift = c.steer > 0 ? 1 : -1; r.driftCharge = 0; }
    }
    if (!c.drift) {
      if (r.drift !== 0) {
        if (r.driftCharge >= CFG.driftT2) { r.boost = Math.max(r.boost, 1.35); if (r.isPlayer) Sound.boost(); }
        else if (r.driftCharge >= CFG.driftT1) { r.boost = Math.max(r.boost, 0.85); if (r.isPlayer) Sound.boost(); }
      }
      r.drift = 0; r.driftCharge = 0; r.driftReady = false;
    }
    if (r.hop > 0) r.hop -= dt;
    if (r.speed < T.driftDrop) { r.drift = 0; r.driftCharge = 0; }

    if (r.drift !== 0) {
      const prevCharge = r.driftCharge;
      r.driftCharge += dt * r.mods.drift;
      if (r.isPlayer) {
        if (prevCharge < CFG.driftT1 && r.driftCharge >= CFG.driftT1) Sound.blip(980, 0.07, 'square', 0.11);
        if (prevCharge < CFG.driftT2 && r.driftCharge >= CFG.driftT2) Sound.blip(1380, 0.09, 'square', 0.12);
      }
      const inward = c.steer * r.drift;
      const rate = steerPower * (0.52 + 0.42 * (inward + 1) / 2 + 0.25);
      r.angle += r.drift * rate * dt * 0.72;
      r.visYaw = angNorm(r.visYaw + angNorm(r.angle + r.drift * 0.5 - r.visYaw) * Math.min(1, dt * 12));
    } else {
      if (r.speed !== 0) {
        r.angle += c.steer * steerPower * dt *
          clamp(Math.abs(r.speed) / T.steerRef, 0, 1) * Math.sign(r.speed || 1);
      }
      r.visYaw = angNorm(r.visYaw + angNorm(r.angle - r.visYaw) * Math.min(1, dt * 14));
    }
    r.steerVis = c.steer;
  }

  if (r.boost > 0) r.boost -= dt;
  if (r.star > 0) r.star -= dt;
  if (r.boostPadCd > 0) r.boostPadCd -= dt;

  r.hopZ = r.hop > 0 ? Math.sin((0.18 - r.hop) / 0.18 * Math.PI) * 1.1 : 0;

  // slipstream: tuck in behind someone at speed for a second, get a surge
  if (r.spin <= 0 && r.stall <= 0 && r.speed > T.draftGate) {
    let drafting = false;
    const fx2 = Math.cos(r.angle), fz2 = Math.sin(r.angle);
    for (const o of G.racers) {
      if (o === r || o.finished) continue;
      const dx = o.x - r.x, dz = o.z - r.z;
      const ahead = dx * fx2 + dz * fz2;
      if (ahead < 3 || ahead > 15) continue;
      const side = Math.abs(dx * -fz2 + dz * fx2);
      if (side < 3.2 && Math.abs(o.speed) > T.draftMin) { drafting = true; break; }
    }
    if (drafting) {
      r.draft = (r.draft || 0) + dt;
      if (r.draft > 1.0) {
        r.draft = 0;
        r.boost = Math.max(r.boost, 0.6);
        if (r.isPlayer) { Sound.sweep(400, 900, 0.3, 0.08); showMsg('SLIPSTREAM!', 0.9); }
      }
    } else r.draft = Math.max(0, (r.draft || 0) - dt * 2);
  }

  r.x += Math.cos(r.angle) * r.speed * dt;
  r.z += Math.sin(r.angle) * r.speed * dt;

  // world bounds
  const M = CFG.gridE - 30;
  if (r.x < -M || r.x > M || r.z < -M || r.z > M) {
    r.x = clamp(r.x, -M, M);
    r.z = clamp(r.z, -M, M);
    r.speed *= 0.35;
  }

  // track query + barrier + ground follow
  r.q = track.query(r.x, r.z, r.sHint);
  r.sHint = r.q.sIdx;
  hitBarrier(r);
  r.offTrack = r.q.onRoad ? 0 : r.q.dist;
  // Sit on the surface, not near it. This used to be a low-pass filter, which
  // put the kart wherever the road was about 70ms ago — floating over crests
  // and sunk into dips, by up to three wheel radii on the hilly tracks. The
  // query height is exact now, so there is nothing left to smooth away.
  r.groundY = r.q.groundY;

  // boost pads
  if (r.boostPadCd <= 0 && r.q.onRoad) {
    for (const pad of track.boostPads) {
      const rel = ((r.q.sIdx - pad.s0) % track.N + track.N) % track.N;
      if (rel <= 9 && Math.abs(r.q.lat) <= pad.latMax) {
        r.boost = Math.max(r.boost, 1.05);
        r.boostPadCd = 1.2;
        if (r.isPlayer) Sound.boost();
        break;
      }
    }
  }

  // jump ramps
  if (r.airY <= 0 && r.q.onRoad && r.speed > T.rampMin) {
    for (const ramp of track.ramps) {
      const rel = ((r.q.sIdx - ramp.s0) % track.N + track.N) % track.N;
      if (rel <= 2 && Math.abs(r.q.lat) <= ramp.latMax) {
        r.airV = T.airLaunch + r.speed * 0.13;
        r.airY = 0.01;
        r.airW = r.groundY + 0.01;
        r.prevAirDrift = true;          // require a fresh drift press for the trick
        if (r.isPlayer) Sound.sweep(300, 700, 0.25, 0.1);
        break;
      }
    }
  }
}

// --- barriers -------------------------------------------------------------------

// How far past the barrier face the kart's centre has strayed. Negative while
// it is still clear of the wall.
function barrierOut(track, q) {
  return Math.abs(q.lat) - (track.railLat - CFG.kartRadius);
}

// The barrier is the track's, not the kart's: `railAt` says where a wall stands
// and `railLat` says how far out it is, and the mesh you can see is built from
// the same two. A kart that reaches it gets turned along it and scrubs speed
// rather than driving through the thing in front of it.
function hitBarrier(r) {
  const track = G.track;
  const q = r.q;
  const out = barrierOut(track, q);
  r.behindWall = false;
  if (out <= 0) { r.wallOut = out; return; }

  const side = q.lat < 0 ? -1 : 1;
  const bit = side < 0 ? track.RAIL_NEG : track.RAIL_POS;
  if (!(track.railAt[q.sIdx] & bit)) { r.wallOut = out; return; }   // open here
  // Already outside when the wall began, so it came round the end of one rather
  // than through it. Shoving it back would be a teleport; instead mark it out
  // of bounds and let the rescue pick it up.
  if (r.wallOut > 0.6) { r.wallOut = out; r.behindWall = true; return; }

  const nx = -q.tz * side, nz = q.tx * side;          // outward wall normal
  r.x -= nx * out;
  r.z -= nz * out;
  r.wallOut = 0;
  // The kart moved, so everything downstream that reads the query — off-track
  // distance, boost pads, ramps — has to be reading where it actually is.
  r.q = track.query(r.x, r.z, r.sHint);
  r.sHint = r.q.sIdx;

  // Resolve in velocity space rather than off the heading, so backing into a
  // wall behaves the same as driving into one.
  const vx = Math.cos(r.angle) * r.speed, vz = Math.sin(r.angle) * r.speed;
  const into = vx * nx + vz * nz;
  if (into <= 0) return;                               // already running away

  // Keep the run along the wall, drop the run into it: a glancing scrape barely
  // costs anything, a square hit stops you dead. `square` is how head-on the
  // contact was, 0 for a graze and 1 for a wall you drove straight at.
  const ax = vx - nx * into, az = vz - nz * into;
  const along = Math.hypot(ax, az);
  const before = Math.abs(r.speed);
  const square = before > 1e-4 ? into / before : 0;
  const sgn = r.speed < 0 ? -1 : 1;
  // Deflect toward the wall's line, but only as far as the contact earns it: a
  // graze steers you along the barrier, a square hit stops you nose-in rather
  // than spinning the kart round for you.
  if (along > 1e-4) {
    const want = Math.atan2(az * sgn / along, ax * sgn / along);
    r.angle = angNorm(r.angle + angNorm(want - r.angle) * (1 - square));
  }
  r.speed = sgn * along * (1 - 0.25 * square);         // plus a little scrub
  if (square > 0.45) { r.drift = 0; r.driftCharge = 0; r.driftReady = false; }

  const impact = before * square;
  if (impact > 6) {
    const [cx, cz] = [r.x + nx * CFG.kartRadius, r.z + nz * CFG.kartRadius];
    for (let k = 0; k < (impact > 30 ? 5 : 2); k++) {
      sparkPool.emit(cx, r.groundY + 0.7, cz,
        -nx * 6 + (Math.random() - 0.5) * 8, 2 + Math.random() * 5, -nz * 6 + (Math.random() - 0.5) * 8,
        0.28, 1, 0.85, 0.45);
    }
    if (r.isPlayer) {
      G.cam.shake = Math.max(G.cam.shake, Math.min(0.75, impact / 60));
      if (impact > 18 && Math.random() < 0.6) Sound.bump();
    }
  }
}

// --- AI -------------------------------------------------------------------------

function aiControls(r, dt) {
  const track = G.track;
  const wps = track.wps, n = wps.length;
  const a = r.ai;
  const T = G.tune;

  a.nextOffset -= dt;
  if (a.nextOffset <= 0) {
    a.offset = (Math.random() * 2 - 1) * 0.62;
    a.nextOffset = 1.5 + Math.random() * 3;
  }
  a.wobble += dt * 1.4;

  const look = 2 + Math.round(Math.abs(r.speed) / 46);
  const tw = wps[(r.wpIdx + look) % n];
  const lat = (a.offset + Math.sin(a.wobble) * 0.12) * (CFG.roadWidth * 0.34);
  const tx = tw.x + (-tw.tz) * lat, tz = tw.z + tw.tx * lat;

  const want = Math.atan2(tz - r.z, tx - r.x);
  const err = angNorm(want - r.angle);
  const steer = clamp(err * 2.6, -1, 1);

  const curveAhead = Math.max(
    wps[(r.wpIdx + 2) % n].curve,
    wps[(r.wpIdx + 4) % n].curve,
    wps[(r.wpIdx + 6) % n].curve);

  // One pace number, and it has to reach the corners.
  //
  // The AI is corner-limited: its straight-line cap is almost never what holds
  // it back. So a difficulty dial that only moved `aiGrade` — which is all the
  // rubber band used to do — moved a ceiling the AI spends most of a lap well
  // under, and did approximately nothing. Both the band and the adaptive scale
  // now multiply corner commitment as well, which is the thing that actually
  // sets a lap time.
  //
  // Overcooking a corner is self-limiting now that the barriers are solid: a
  // kart that carries too much speed scrubs it off against the wall instead of
  // sailing away across the grass.
  const me = G.racers[0];
  const gap = (me.rank || 0) - (r.rank || 0);
  const band = r.id === G.rivalId ? T.band * 2 : T.band;
  // Field pace is for the field. The player is normally driving themselves, but
  // the autopilot shares this function, and scaling it by the very number it is
  // being measured against would make the calibration chase its own tail.
  const adjust = (r.isPlayer ? 1 : G.paceScale) *
    (1 + clamp(gap / (n * 0.55), -1, 1) * band);
  const base = T.skill * a.grade;

  // Corner commitment takes the whole adjustment. Measured over a full race at
  // 50cc the AI never exceeded 55 of its 57 available speed units, so its cap
  // was never the constraint — the corners were.
  const cornerSpeed = T.topSpeed * clamp(1.06 - curveAhead * 1.15, 0.55, 1) *
    T.corner * base * adjust;

  // The straight-line cap takes a damped share of it. A rival that simply
  // out-drags you down the straight reads as the game cheating however fair
  // the arithmetic is, where one that carries more speed through a corner just
  // reads as a better driver.
  r.aiGrade = base * (1 + (adjust - 1) * TOP_SHARE);
  const brake = r.speed > cornerSpeed * 1.12;
  const coast = r.speed > cornerSpeed;

  // contextual item usage: bananas go into corner entries, shells need a
  // target roughly ahead; everything else fires on the timer
  a.itemTimer -= dt;
  let useIt = false;
  if (r.item && a.itemTimer <= 0) {
    const kind = r.item;
    let ok = true;
    if (kind === 'banana' || kind === 'oil') {
      ok = curveAhead > 0.22 || a.itemTimer < -6;      // hold for a corner, or give up
    } else if (kind === 'green' || kind === 'red') {
      ok = false;
      const range = kind === 'red' ? 75 : 55;
      for (const o of G.racers) {
        if (o === r || o.finished) continue;
        const dx = o.x - r.x, dz = o.z - r.z;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        if (Math.abs(angNorm(Math.atan2(dz, dx) - r.angle)) < 0.4) { ok = true; break; }
      }
      if (a.itemTimer < -8) ok = true;                 // don't hoard forever
    }
    if (ok) { useIt = true; a.itemTimer = 2 + Math.random() * 5; }
  }

  return {
    steer,
    gas: !coast,
    brake,
    drift: Math.abs(steer) > 0.45 && r.speed > T.aiDriftGate && T.skill > 0.9,
    item: useIt,
  };
}

// --- collisions / hazards ----------------------------------------------------------

function collideKarts() {
  for (let i = 0; i < G.racers.length; i++) {
    for (let j = i + 1; j < G.racers.length; j++) {
      const a = G.racers[i], b = G.racers[j];
      // one of them is in the air over the other: no contact
      if (Math.abs((a.airY || 0) - (b.airY || 0)) > 2.4) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const min = CFG.kartRadius * 2;
      if (d > min || d === 0) continue;
      const nx = dx / d, nz = dz / d;
      // heavier karts shove lighter ones out of the way
      const ma = a.stats.mass, mb = b.stats.mass;
      const push = (min - d);
      a.x -= nx * push * (mb / (ma + mb)); a.z -= nz * push * (mb / (ma + mb));
      b.x += nx * push * (ma / (ma + mb)); b.z += nz * push * (ma / (ma + mb));
      if (a.star > 0 && b.star <= 0) hitRacer(b, true);
      else if (b.star > 0 && a.star <= 0) hitRacer(a, true);
      else {
        // Equal and opposite, so a pack cannot manufacture speed out of
        // contact. Same mass ratio the positional shove above uses, doubled so
        // two equal karts trade exactly `swap` as they always did.
        const swap = (a.speed - b.speed) * 0.25;
        a.speed -= swap * 2 * mb / (ma + mb);
        b.speed += swap * 2 * ma / (ma + mb);
        if ((a.isPlayer || b.isPlayer) && Math.abs(swap) > 1.2) {
          if (Math.random() < 0.4) Sound.bump();
          G.cam.shake = Math.max(G.cam.shake, 0.3);
          sparkPool.emit((a.x + b.x) / 2, a.groundY + 1, (a.z + b.z) / 2,
            (Math.random() - 0.5) * 10, 4, (Math.random() - 0.5) * 10,
            0.3, 1, 0.9, 0.5);
        }
      }
    }
  }
}

function updateHazards(dt) {
  const track = G.track;

  for (let i = G.bananas.length - 1; i >= 0; i--) {
    const b = G.bananas[i];
    b.life -= dt;
    let dead = b.life <= 0;
    if (!dead) {
      for (const r of G.racers) {
        if (r.finished || r.spin > 0 || r.airY > 0) continue;
        if (Math.hypot(r.x - b.x, r.z - b.z) < CFG.kartRadius + 1.6) {
          hitRacer(r, false);
          dead = true;
          break;
        }
      }
    }
    if (dead) { scene.remove(b.mesh); G.bananas.splice(i, 1); }
  }

  for (let i = G.shells.length - 1; i >= 0; i--) {
    const s = G.shells[i];
    s.life -= dt;
    if (s.life <= 0) { scene.remove(s.mesh); G.shells.splice(i, 1); continue; }

    if (s.kind === 'red' && s.target && !s.target.finished) {
      const want = Math.atan2(s.target.z - s.z, s.target.x - s.x);
      s.angle = angNorm(s.angle + angNorm(want - s.angle) * Math.min(1, dt * 4.5));
    }
    s.x += Math.cos(s.angle) * s.speed * dt;
    s.z += Math.sin(s.angle) * s.speed * dt;
    const q = track.query(s.x, s.z, s.sHint);
    s.sHint = q.sIdx;
    s.groundY = q.groundY;

    // The same barrier the karts hit: a shell ricochets where there is a wall
    // to ricochet off, and flies away down the open sections instead of
    // skipping along an invisible one.
    //
    // The barrier stands a little way beyond the kerb, so the ground directly
    // in front of it is off-road. A shell has to be allowed to cross that strip
    // — culling it there for leaving the road is what made shells vanish into
    // the barrier instead of bouncing off it.
    const bit = q.lat < 0 ? track.RAIL_NEG : track.RAIL_POS;
    const walled = (track.railAt[q.sIdx] & bit) !== 0;
    const past = Math.abs(q.lat) - (track.railLat - SHELL_RADIUS);

    if (walled && past > 3) {
      // Behind the barrier: it came round the end of one through a gap, and is
      // out of play. Bouncing it here would fire it back through the wall.
      scene.remove(s.mesh); G.shells.splice(i, 1); continue;
    }
    if (walled && past > 0) {
      // mirror the heading across the track tangent
      const tA = Math.atan2(q.tz, q.tx);
      s.angle = angNorm(2 * tA - s.angle);
      const push = past * Math.sign(q.lat);
      s.x -= (-q.tz) * push;
      s.z -= q.tx * push;
      s.bounces = (s.bounces || 0) + 1;
      // A green shell ricochets until it runs out of patience; a red one is
      // held to its own lifetime, since it re-acquires its target after every
      // deflection and should not be cheaper to survive for bouncing.
      if (s.kind === 'green' && s.bounces > 6) { scene.remove(s.mesh); G.shells.splice(i, 1); continue; }
    } else if (!walled && !q.onRoad && s.life < 8.4) {
      scene.remove(s.mesh); G.shells.splice(i, 1); continue;
    }

    let hit = false;
    for (const r of G.racers) {
      if (r.finished || r.airY > 0) continue;
      if (r.id === s.owner && s.life > 8.6) continue;
      if (Math.hypot(r.x - s.x, r.z - s.z) < CFG.kartRadius + 1.8) {
        hitRacer(r, true);
        hit = true;
        break;
      }
    }
    if (hit) { scene.remove(s.mesh); G.shells.splice(i, 1); }
  }

  // oil slicks
  for (let i = G.oils.length - 1; i >= 0; i--) {
    const o = G.oils[i];
    o.life -= dt;
    if (o.grace > 0) o.grace -= dt;
    if (o.life <= 0) { scene.remove(o.mesh); G.oils.splice(i, 1); continue; }
    for (const r of G.racers) {
      if (r.finished || r.slip > 0.4 || r.star > 0 || r.airY > 0) continue;
      if (r.id === o.owner && o.grace > 0) continue;
      if (Math.hypot(r.x - o.x, r.z - o.z) < 3.2) {
        r.slip = 1.2;
        r.drift = 0; r.driftCharge = 0;
        if (r.isPlayer) Sound.bump();
      }
    }
  }

  // comets
  for (let i = G.comets.length - 1; i >= 0; i--) {
    const c = G.comets[i];
    c.t += dt;
    const k = Math.min(1, c.t / c.dur);
    const tgt = c.target;
    c.x = lerp(c.sx, tgt.x, k);
    c.z = lerp(c.sz, tgt.z, k);
    c.y = lerp(c.sy, tgt.groundY + 1, k) + Math.sin(k * Math.PI) * 32;
    if (k >= 1) {
      spawnRing(c.x, c.y, c.z, 15, 0xff8a40);
      Sound.boom();
      for (const o of G.racers) {
        if (o.finished) continue;
        // spherical blast: a big jump can clear it, a low hop cannot
        if (Math.hypot(o.x - c.x, o.z - c.z, o.airY || 0) < 13) {
          if (hitRacer(o, true)) o.speed *= 0.3;
        }
      }
      for (let p = 0; p < 22; p++) {
        sparkPool.emit(c.x, c.y, c.z,
          (Math.random() - 0.5) * 26, Math.random() * 16, (Math.random() - 0.5) * 26,
          0.7, 1, 0.6, 0.25);
      }
      scene.remove(c.mesh);
      G.comets.splice(i, 1);
    }
  }

  // themed hazards
  for (const gy of track.geysers) {
    gy.active = Math.sin(G.time * 1.1 + gy.phase) > 0.55;
    if (!gy.active) continue;
    for (const r of G.racers) {
      if (r.finished || r.airY > 0) continue;
      if (Math.hypot(r.x - gy.x, r.z - gy.z) < gy.r) {
        r.airV = G.tune.geyserLaunch;
        r.airY = 0.01;
        r.airW = r.groundY + 0.01;
        r.speed *= 0.7;
        if (r.isPlayer) { Sound.noiseBurst(0.4, 300, 0.25); G.cam.shake = 0.8; }
      }
    }
  }
  for (const lp of track.lavaPools) {
    for (const r of G.racers) {
      if (r.finished || r.airY > 0 || r.spin > 0) continue;
      if (Math.hypot(r.x - lp.x, r.z - lp.z) < lp.r) {
        if (hitRacer(r, true)) {
          r.speed *= 0.15;
          r.forceRescue = 0.9;           // lava always ends in a rescue teleport
        }
      }
    }
  }
  for (const sm of track.snowmen) {
    if (!sm.alive) continue;
    for (const r of G.racers) {
      if (r.finished || r.airY > 3.2) continue;      // cleared it in the air
      if (Math.hypot(r.x - sm.x, r.z - sm.z) < 2.7) {
        sm.alive = false;
        sm.group.visible = false;
        r.speed *= 0.82;
        for (let p = 0; p < 14; p++) {
          dustPool.emit(sm.x, 1.5 + Math.random() * 2.5, sm.z,
            (Math.random() - 0.5) * 14, 3 + Math.random() * 7, (Math.random() - 0.5) * 14,
            0.7, 0.95, 0.97, 1);
        }
        if (r.isPlayer) Sound.bump();
        break;
      }
    }
  }

  // coins (player only — they're your pocket money)
  {
    const p = G.racers[0];
    if (!p.finished) {
      for (const c of track.coins) {
        if (c.taken) continue;
        const dx = p.x - c.x, dz = p.z - c.z;
        if (dx * dx + dz * dz < 2.6 * 2.6) {
          c.taken = true;
          c.mesh.visible = false;
          G.coinsThisRace++;
          Garage.addCoins(1);
          Sound.coin();
          for (let k = 0; k < 5; k++) {
            glowPool.emit(c.x, c.y, c.z,
              (Math.random() - 0.5) * 8, 3 + Math.random() * 5, (Math.random() - 0.5) * 8,
              0.35, 1, 0.85, 0.3);
          }
        }
      }
    }
  }

  // item boxes
  for (const box of track.itemBoxes) {
    if (box.cooldown > 0) { box.cooldown -= dt; continue; }
    for (const r of G.racers) {
      if (r.finished || r.item || r.itemRoll > 0) continue;
      const dx = r.x - box.x, dz = r.z - box.z;
      if (dx * dx + dz * dz < 4.4 * 4.4) {
        box.cooldown = 4;
        r.itemRoll = r.isPlayer ? 1.1 : 0.2;
        r.pendingItem = rollItem(r.place, G.racers.length);
        if (r.isPlayer) Sound.pickup();
        for (let k = 0; k < 8; k++) {
          glowPool.emit(box.x, box.y, box.z,
            (Math.random() - 0.5) * 10, 3 + Math.random() * 6, (Math.random() - 0.5) * 10,
            0.5, 0.55, 0.85, 1);
        }
        break;
      }
    }
  }
}

// --- main step ---------------------------------------------------------------------

export function stepRace(dt) {
  G.time += dt;
  // AI keeps racing to the line while the player looks at the results screen
  const racing = G.state === 'RACE' || G.state === 'RESULTS';
  const zero = { steer: 0, gas: false, brake: false, drift: false, item: false };

  for (const r of G.racers) {
    if (r.itemRoll > 0) {
      r.itemRoll -= dt;
      r.rollIcon = (r.rollIcon + dt * 16) % 10;
      if (r.itemRoll <= 0) { r.item = r.pendingItem; r.pendingItem = null; }
    }

    let c;
    if (r.finished) {
      // victory lap: finished racers keep driving the track properly
      c = aiControls(r, dt);
      c.item = false;
    }
    else if (!racing) {
      c = zero;
      // rocket-start timing: track how long the player revs before GO
      if (r.isPlayer && !G.auto && G.state === 'COUNTDOWN') {
        if (revving()) G.startGasTime += dt;
        else G.startGasTime = 0;
      }
    }
    else if (r.isPlayer && !G.auto) c = readControls();
    else c = aiControls(r, dt);

    // the gamepad edge detector must tick every frame, not only while held
    const playerEdge = (r.isPlayer && !G.auto && racing) ? itemPressed() : false;
    if (racing && !r.finished && c.item) {
      if (r.isPlayer && !G.auto) { if (playerEdge) useItem(r); }
      else useItem(r);
    }

    driveRacer(r, c, dt);
    updateProgress(r);

    // lava dunks force a rescue once the spin finishes
    if (r.forceRescue > 0) {
      r.forceRescue -= dt;
      if (r.forceRescue <= 0) r.respawn = 99;
    }

    // rescue if hopelessly far off the track, or stranded behind a barrier
    if (r.offTrack > 60 || r.respawn > 90 || r.behindWall) {
      r.respawn += dt;
      if (r.respawn > 1.4) {
        const w = G.track.wps[r.wpIdx];
        r.x = w.x; r.z = w.z;
        r.angle = Math.atan2(w.tz, w.tx);
        r.visYaw = r.angle;
        r.speed = G.tune.rescueSpeed;
        r.respawn = 0;
        r.airY = 0; r.airV = 0; r.airW = r.q ? r.q.groundY : 0;
        r.slip = 0; r.stall = 0; r.spin = 0;
        r.forceRescue = 0; r.grapple = null;
        r.q = G.track.query(r.x, r.z, w.sIdx);
        r.sHint = r.q.sIdx;
        r.groundY = r.q.groundY;
        r.wallOut = barrierOut(G.track, r.q);
        r.behindWall = false;
        if (r.isPlayer) showMsg('BACK ON TRACK', 1.2);
      }
    } else r.respawn = 0;
  }

  collideKarts();
  updateHazards(dt);
  updatePlaces();

  // time-trial ghost recording (10 Hz)
  if (G.ghostRec && racing && !G.racers[0].finished) {
    G.ghostAcc += dt;
    while (G.ghostAcc >= 0.1) {
      G.ghostAcc -= 0.1;
      const p0 = G.racers[0];
      G.ghostRec.push(
        Math.round(p0.x * 100) / 100,
        Math.round(p0.z * 100) / 100,
        Math.round(p0.visYaw * 1000) / 1000);
    }
  }

  // taunt chirp from whoever just passed the player
  if (G.tauntCd > 0) G.tauntCd -= dt;
  const me = G.racers[0];
  if (racing && !me.finished && me.place > G.prevPlayerPlace && G.tauntCd <= 0) {
    const passer = G.racers.find((r) => r.place === me.place - 1 && !r.isPlayer);
    if (passer) { Sound.taunt(passer.voice); G.tauntCd = 3; }
  }
  G.prevPlayerPlace = me.place;

  // chase camera (math only; applied to the THREE camera in main)
  const p = G.racers[0];
  const k = Math.min(1, dt * 6.5);
  G.cam.angle = angNorm(G.cam.angle + angNorm(p.angle - G.cam.angle) * k);
  const speedRatio = clamp(Math.abs(p.speed) / G.tune.topSpeed, 0, 1.6);
  const dist = CFG.camDist + speedRatio * 1.6;
  const wantX = p.x - Math.cos(G.cam.angle) * dist;
  const wantZ = p.z - Math.sin(G.cam.angle) * dist;
  G.cam.x += (wantX - G.cam.x) * Math.min(1, dt * 12);
  G.cam.z += (wantZ - G.cam.z) * Math.min(1, dt * 12);
  G.cam.shake *= Math.pow(0.01, dt);

  if (G.msgTime > 0) G.msgTime -= dt;
}

// --- per-frame visual sync -----------------------------------------------------------

export function syncVisuals(dt, time) {
  const track = G.track;
  if (!track) return;

  // during the podium ceremony the karts are posed by hand — don't overwrite
  for (const r of (G.state === 'PODIUM' ? [] : G.racers)) {
    // terrain pitch/roll from the composite ground height
    const fx = Math.cos(r.visYaw), fz = Math.sin(r.visYaw);
    const gF = track.query(r.x + fx * 2.3, r.z + fz * 2.3, r.sHint).groundY;
    const gB = track.query(r.x - fx * 2.3, r.z - fz * 2.3, r.sHint).groundY;
    const gL = track.query(r.x - (-fz) * 1.7, r.z - fx * 1.7, r.sHint).groundY;
    const gR = track.query(r.x + (-fz) * 1.7, r.z + fx * 1.7, r.sHint).groundY;
    const tPitch = Math.atan2(gF - gB, 4.6);
    const tRoll = Math.atan2(gL - gR, 3.4);
    r.pitch += (tPitch - r.pitch) * Math.min(1, dt * 9);
    r.roll += (tRoll - r.roll) * Math.min(1, dt * 9);

    r.visual.update(r, dt, time);

    const spd = Math.abs(r.speed);

    // drift sparks + skid marks
    if (r.drift !== 0 && r.driftCharge > 0.2 && r.q && r.q.onRoad) {
      const tier = r.driftCharge >= CFG.driftT2 ? [1, 0.55, 0.15] :
        (r.driftCharge >= CFG.driftT1 ? [0.35, 0.85, 1] : [0.9, 0.9, 0.95]);
      const side = (-fz), sideZ = fx;
      for (const lat of [1.62, -1.62]) {
        const wx = r.x + fx * -1.6 + side * lat;
        const wz = r.z + fz * -1.6 + sideZ * lat;
        if (Math.random() < 0.85) {
          sparkPool.emit(wx, r.groundY + 0.3, wz,
            -fx * 6 + (Math.random() - 0.5) * 8, 2 + Math.random() * 4, -fz * 6 + (Math.random() - 0.5) * 8,
            0.3 + Math.random() * 0.2, tier[0], tier[1], tier[2]);
        }
      }
      const wLx = r.x + fx * -1.6 + side * 1.62, wLz = r.z + fz * -1.6 + sideZ * 1.62;
      const wRx = r.x + fx * -1.6 - side * 1.62, wRz = r.z + fz * -1.6 - sideZ * 1.62;
      if (r._skidL) {
        skids.add(r._skidL[0], r.groundY + 0.16, r._skidL[1], wLx, r.groundY + 0.16, wLz, 0.45);
        skids.add(r._skidR[0], r.groundY + 0.16, r._skidR[1], wRx, r.groundY + 0.16, wRz, 0.45);
      }
      r._skidL = [wLx, wLz];
      r._skidR = [wRx, wRz];
    } else {
      r._skidL = r._skidR = null;
    }

    // off-road dust
    if (r.q && !r.q.onRoad && spd > 8 && Math.random() < 0.55) {
      dustPool.emit(
        r.x - fx * 1.5 + (Math.random() - 0.5) * 2, r.groundY + 0.4, r.z - fz * 1.5 + (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 4, 2.5 + Math.random() * 3, (Math.random() - 0.5) * 4,
        0.65, 0.62, 0.55, 0.42);
    }

    // boost flames trail
    if (r.boost > 0 && Math.random() < 0.9) {
      glowPool.emit(
        r.x - fx * 3.1, r.groundY + 1.1, r.z - fz * 3.1,
        -fx * 14 + (Math.random() - 0.5) * 3, 1, -fz * 14 + (Math.random() - 0.5) * 3,
        0.3, 1, 0.6 + Math.random() * 0.3, 0.15);
    }

    // star sparkles
    if (r.star > 0 && Math.random() < 0.7) {
      const hue = Math.random();
      const c = new THREE.Color().setHSL(hue, 0.95, 0.65);
      glowPool.emit(
        r.x + (Math.random() - 0.5) * 3, r.groundY + 0.5 + Math.random() * 2, r.z + (Math.random() - 0.5) * 3,
        0, 3, 0, 0.45, c.r, c.g, c.b);
    }
  }

  // Pickups catch a slow travelling highlight. These materials are shared by
  // every coin and every box, so the whole effect is three property writes.
  if (track.shine) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
    if (track.shine.coin) track.shine.coin.emissiveIntensity = 0.55 + pulse * 1.0;
    if (track.shine.edge) track.shine.edge.opacity = 0.7 + pulse * 0.3;
    if (track.shine.box) track.shine.box.opacity = 0.32 + pulse * 0.16;
  }

  // Pickups catch a slow travelling highlight. These materials are shared by
  // every coin and every box, so the whole effect is three property writes.
  if (track.shine) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
    if (track.shine.coin) track.shine.coin.emissiveIntensity = 0.55 + pulse * 1.0;
    if (track.shine.edge) track.shine.edge.opacity = 0.7 + pulse * 0.3;
    if (track.shine.box) track.shine.box.opacity = 0.32 + pulse * 0.16;
  }

  // item boxes
  for (const box of track.itemBoxes) {
    if (box.cooldown > 0) {
      if (box.group.visible) box.group.visible = false;
    } else {
      if (!box.group.visible) { box.group.visible = true; box.group.scale.set(0.01, 0.01, 0.01); }
      const s = box.group.scale.x;
      if (s < 1) {
        const ns = Math.min(1, s + dt * 3);
        box.group.scale.set(ns, ns, ns);
      }
      box.cube.rotation.y = time * 1.3 + box.phase;
      box.cube.rotation.x = time * 0.9 + box.phase;
      box.group.position.y = box.y + Math.sin(time * 2 + box.phase) * 0.25;
    }
  }

  // projectiles
  for (const s of G.shells) {
    s.mesh.position.set(s.x, s.groundY + 0.85, s.z);
    s.mesh.rotation.y = -s.angle;
    s.mesh.children[0].rotation.y += dt * 9;
  }
  for (const b of G.bananas) {
    b.mesh.position.y = b.groundY + Math.max(0, (b.life > 24.4 ? (b.life - 24.4) * 4 : 0));
  }

  updateGhostPlayback();

  // coins spin
  for (const c of track.coins) {
    if (c.taken) continue;
    c.mesh.rotation.y = time * 2.6;
    c.mesh.position.y = c.y + Math.sin(time * 2 + c.x) * 0.15;
  }

  // geysers
  for (const gy of track.geysers) {
    const want = gy.active ? 1 : 0.03;
    gy.mesh.scale.y += (want - gy.mesh.scale.y) * Math.min(1, dt * 7);
    gy.mesh.position.y = gy.baseY + 7.5 * gy.mesh.scale.y;
    if (gy.active && Math.random() < 0.5) {
      sparkPool.emit(gy.x + (Math.random() - 0.5) * 3, gy.baseY + 13, gy.z + (Math.random() - 0.5) * 3,
        (Math.random() - 0.5) * 8, 6 + Math.random() * 8, (Math.random() - 0.5) * 8,
        0.6, 1, 0.55, 0.2);
    }
  }

  // comets + shockwave rings + grapple lines
  for (const c of G.comets) {
    c.mesh.position.set(c.x, c.y, c.z);
    if (Math.random() < 0.85) {
      glowPool.emit(c.x, c.y, c.z,
        (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4,
        0.5, 0.45, 0.75, 1);
    }
  }
  for (let i = G.rings.length - 1; i >= 0; i--) {
    const rg = G.rings[i];
    rg.t += dt;
    const k = rg.t / rg.dur;
    if (k >= 1) {
      killRing(rg);
      G.rings.splice(i, 1);
      continue;
    }
    const s = 1 + k * rg.maxR;
    rg.mesh.scale.set(s, 1, s);
    rg.mesh.material.opacity = 0.9 * (1 - k);
  }
  for (let i = G.grapples.length - 1; i >= 0; i--) {
    const gp = G.grapples[i];
    if (!gp.owner.grapple) {
      killGrapple(gp);
      G.grapples.splice(i, 1);
      continue;
    }
    const pos = gp.line.geometry.attributes.position;
    pos.setXYZ(0, gp.owner.x, gp.owner.groundY + 1.4, gp.owner.z);
    pos.setXYZ(1, gp.target.x, gp.target.groundY + 1.4, gp.target.z);
    pos.needsUpdate = true;
  }

  sparkPool.update(dt);
  glowPool.update(dt);
  dustPool.update(dt);
  skids.update(dt);
}

export function hideRacers() {
  for (const v of visuals) v.removeFrom(scene);
}

export function getVisuals() { return visuals; }

export function clearFx() {
  sparkPool.clear();
  dustPool.clear();
  glowPool.clear();
  skids.clear();
}
