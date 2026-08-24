// ---------------------------------------------------------------------------
// Boot, renderer, camera, state machine, main loop.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CFG, TRACK_DEFS, DIFFICULTIES } from './config.js';
import { clamp, lerp, angNorm } from './util.js';
import {
  keys, wasPressed, clearPressed, setFirstInputHook, lookingBack, readControls,
} from './input.js';
import { initTouch, setRevMode, touch } from './touch.js';
import { Sound } from './audio.js';
import { buildTrackFromDef, invalidateCustomExcept } from './track.js';
import {
  getTrackDef, trackCount, loadCustomDef, saveCustomDef, newCustomDef,
  applyTheme, generateLayout, THEME_BASES,
} from './tracklab.js';
import { TrackEditor } from './editor.js';
import { Renderer, SunShadow } from './render.js';
import {
  G, initRace, startRace, stepRace, syncVisuals, hideRacers, getVisuals, clearFx,
  awardGpPoints, confettiBurst, cleanupGhost, resolveRocketStart,
} from './race.js';
import {
  initHUD, showScreen, updateMenu, updateHUD, updatePause, setCountdown,
  showResults, bindMenuClicks, bindPauseClicks, setLoading,
  updateCharSel, bindCharSelClicks,
  renderGarage, bindGarageClicks, garageColCount,
  showPodium, hidePodium, bindScreenButtons,
} from './hud.js';
import { CHARACTERS, MODES } from './config.js';
import { Garage } from './garage.js';
import * as Store from './store.js';
import { Playables } from './playables.js';

// --- renderer ---------------------------------------------------------------

const canvas = document.getElementById('gl');
const rig = new Renderer(canvas);
const renderer = rig.gl;

const scene = new THREE.Scene();
scene.environment = rig.envMap;
scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(CFG.fovBase, 1, 0.5, 2600);
const sun = new SunShadow(scene, new THREE.Vector3(0.6, 0.8, 0.4));
rig.attach(scene, camera);

// A narrow window crops the horizontal view — the vertical FOV is what three
// stores, so portrait would otherwise leave you staring at your own rear wheels.
// Give some of the width back, capped well short of fisheye.
let fovBase = CFG.fovBase;

function resize() {
  // A zero-sized viewport is real: an embedding iframe before layout, a tab
  // restored offscreen, the moment a phone rotates. Zero-size render targets
  // make every draw call fail with an incomplete framebuffer, so never let one
  // reach the renderer.
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  rig.setSize(w, h);
  camera.aspect = w / h;
  fovBase = camera.aspect >= 1.3
    ? CFG.fovBase
    : CFG.fovBase * clamp(1.3 / camera.aspect, 1, 1.42);
  camera.updateProjectionMatrix();
  updateRotateHint();
}
addEventListener('resize', resize);
addEventListener('orientationchange', resize);
resize();

setFirstInputHook(() => { Sound.init(); Sound.resume(); });

// Portrait plays, but the track reads far better across the long edge. Nudge
// once per session while racing, and drop the nudge the moment they turn.
let rotateNudged = false;
function updateRotateHint() {
  const hint = document.getElementById('rotateHint');
  if (!hint) return;
  const portrait = innerHeight > innerWidth;
  const racing = G.state === 'COUNTDOWN' || G.state === 'RACE';
  hint.classList.toggle('hidden', !(portrait && racing && touch.active && !rotateNudged));
}

// --- state ------------------------------------------------------------------

let menuSel = 3;
let pauseSel = 0;
let garageSel = { row: 0, col: 0 };
let attachedTrack = null;
let goTimer = 0;
let fov = fovBase;
let prevState = '';
const stats = { frames: 0, ms: 0, fps: 0, last: performance.now() };

// Adaptive resolution. Sustained slow frames step the render scale down; a
// sustained comfortable stretch earns it back. Hysteresis on both sides and a
// cooldown after every change, so it settles instead of oscillating.
const RATIO_STEPS = [1, 1.25, 1.5, 1.75, 2];
const quality = { avg: 16, slow: 0, fast: 0, cooldown: 3 };

function adaptQuality(frameMs) {
  quality.avg += (frameMs - quality.avg) * 0.08;
  if (quality.cooldown > 0) { quality.cooldown -= frameMs / 1000; return; }
  if (quality.avg > 24) { quality.slow += frameMs / 1000; quality.fast = 0; }
  else if (quality.avg < 12) { quality.fast += frameMs / 1000; quality.slow = 0; }
  else { quality.slow = quality.fast = 0; }

  let step = RATIO_STEPS.findIndex((r) => r >= rig.ratio - 0.01);
  if (step < 0) step = RATIO_STEPS.length - 1;
  if (quality.slow > 1.5 && step > 0) {
    if (rig.setRatio(RATIO_STEPS[step - 1])) { quality.cooldown = 3; quality.avg = 16; }
    quality.slow = 0;
  } else if (quality.fast > 6 && step < RATIO_STEPS.length - 1) {
    if (rig.setRatio(RATIO_STEPS[step + 1])) { quality.cooldown = 3; quality.avg = 16; }
    quality.fast = 0;
  }
}

function attachTrack(index) {
  const def = getTrackDef(index);
  const key = def.custom ? 'custom:' + (def.rev || 0)
    : (def.daily ? 'daily:' + def.name : 'std:' + index);
  if (def.custom) invalidateCustomExcept(key);
  const track = buildTrackFromDef(def, key);
  if (attachedTrack === track) return track;
  if (attachedTrack) scene.remove(attachedTrack.group);
  scene.add(track.group);
  const T = track.theme;
  scene.fog = new THREE.Fog(new THREE.Color(T.fog), T.fogNear, T.fogFar);
  scene.background = new THREE.Color(T.fog);
  scene.environmentIntensity = T.stars ? 0.22 : 0.35;
  sun.setTheme(T.dirColor, T.dirInt * 0.85, T.sunDir);
  attachedTrack = track;
  return track;
}

function clearProjectiles() {
  for (const s of G.shells) if (s.mesh) scene.remove(s.mesh);
  for (const b of G.bananas) if (b.mesh) scene.remove(b.mesh);
  for (const o of G.oils) if (o.mesh) scene.remove(o.mesh);
  for (const c of G.comets) if (c.mesh) scene.remove(c.mesh);
  for (const rg of G.rings) if (rg.mesh) scene.remove(rg.mesh);
  for (const gp of G.grapples) if (gp.line) scene.remove(gp.line);
  G.shells = []; G.bananas = []; G.oils = []; G.comets = []; G.rings = []; G.grapples = [];
}

function doStartRace() {
  hideCharPreview();
  rotateHintTimer = 5;
  const track = attachTrack(G.trackIndex);
  startRace(scene, track, G.trackIndex, G.difficulty);
  resetCamera();
  showScreen('hud');
  setRevMode(true);          // countdown: the gas button doubles as REV
}

// --- character select preview -------------------------------------------------

let previewVisual = null;
const _camDir = new THREE.Vector3();

function showCharPreview() {
  hideCharPreview();
  previewVisual = getVisuals()[G.playerChar];
  // show the kart they'll actually drive, parts and paint included
  const m = Garage.mods();
  previewVisual.applyMods(m.tiers, m.paint, CHARACTERS[G.playerChar].palette.body);
  previewVisual.addTo(scene);
  previewVisual.shadow.visible = false;
  previewVisual.bubble.visible = false;
  previewVisual.aura.scale.set(0.001, 0.001, 1);
  for (const f of previewVisual.flames) f.scale.set(0.001, 0.001, 1);
  previewVisual.group.visible = true;
}

function hideCharPreview() {
  if (!previewVisual) return;
  previewVisual.shadow.visible = true;
  previewVisual.removeFrom(scene);
  previewVisual = null;
}

function poseCharPreview(time) {
  if (!previewVisual) return;
  camera.getWorldDirection(_camDir);
  const g = previewVisual.group;
  g.position.copy(camera.position).addScaledVector(_camDir, G.state === 'GARAGE' ? 13 : 17.5);
  g.position.y -= G.state === 'GARAGE' ? 4.2 : 4.6;
  g.rotation.y = time * 0.9;
  previewVisual.tilt.rotation.set(0, 0, 0);
}

function enterCharSel() {
  G.state = 'CHARSEL';
  showScreen('charSel');
  updateCharSel();
  showCharPreview();
}

function charSelDir(dir) {
  G.playerChar = (G.playerChar + dir + CHARACTERS.length) % CHARACTERS.length;
  updateCharSel();
  showCharPreview();
  savePrefs();
  Sound.blip(660, 0.06);
}

function quitToMenu() {
  setRevMode(false);
  clearProjectiles();
  clearFx();
  hideRacers();
  cleanupGhost();                 // a time-trial ghost would linger on the menu
  G.state = 'MENU';
  showScreen('menu');
  updateMenu(menuSel);
  Sound.updateEngine(0, false, 0);
  Sound.music.rush = false;       // drop the final-lap tempo
  setCountdown('');
  updateGateLamps();              // clear any lit start lamps
}

// --- podium ceremony ----------------------------------------------------------

let rotateHintTimer = 0;
let podiumTimer = 0;
let podiumSteps = null;
const podiumFocus = new THREE.Vector3();
const podiumAxis = new THREE.Vector3(1, 0, 0);

function enterPodium() {
  const track = attachedTrack;
  const s = track.samples[8];
  const fx = s.tx, fz = s.tz;
  const sx = -s.tz, sz = s.tx;
  podiumFocus.set(s.x, s.y + CFG.roadLift, s.z);
  // steps spread along the track's lateral axis, so the camera watches from
  // down-track (along the tangent) to keep all three karts side by side
  podiumAxis.set(fx, 0, fz);

  // steps: gold / silver / bronze blocks
  podiumSteps = new THREE.Group();
  const stepDefs = [
    { h: 2.4, lat: 0, color: 0xffd94d },
    { h: 1.6, lat: -7, color: 0xcfd4dc },
    { h: 1.0, lat: 7, color: 0xc98a4b },
  ];
  const top3 = showPodium();                 // fills the DOM, returns top-3 charIdx
  hideRacers();
  cleanupGhost();
  top3.forEach((charIdx, i) => {
    const d = stepDefs[i];
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(6.4, d.h, 6.4),
      new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.4, metalness: 0.35 }));
    step.position.set(s.x + sx * d.lat, s.y + CFG.roadLift + d.h / 2, s.z + sz * d.lat);
    podiumSteps.add(step);
    const v = getVisuals()[charIdx];
    v.addTo(scene);
    v.shadow.visible = false;
    v.group.position.set(s.x + sx * d.lat, s.y + CFG.roadLift + d.h, s.z + sz * d.lat);
    v.group.rotation.y = -Math.atan2(fz, fx);      // face down-track at the camera
    v.tilt.rotation.set(0, 0, 0);
    v.group.visible = true;
    // clear leftover race state so nobody accepts a trophy inside a shield
    v.bubble.visible = false;
    v.aura.scale.set(0.001, 0.001, 1);
    for (const f of v.flames) f.scale.set(0.001, 0.001, 1);
  });
  scene.add(podiumSteps);
  podiumTimer = 0;
  G.state = 'PODIUM';
  Sound.finish(true);
}

function exitPodium() {
  if (podiumSteps) {
    scene.remove(podiumSteps);
    podiumSteps = null;
  }
  for (const v of getVisuals()) v.shadow.visible = true;
  hidePodium();
  G.gp = null;
  quitToMenu();
}

// --- camera -----------------------------------------------------------------

let camLat = 0;      // lateral drift offset, smoothed
let lookBack = 0;    // 0..1 blend for the look-behind camera
const camPos = { x: 0, z: 0, live: false };

// Called whenever the kart teleports (race start, restart, rescue) so the
// camera cuts instead of sweeping in from wherever it was.
function resetCamera() { camPos.live = false; }

function applyCamera(dt) {
  const track = G.track;
  const p = G.racers[0];
  if (!track || !p) return;

  let camAngle = G.cam.angle;
  if (G.state === 'COUNTDOWN') camAngle += (G.countdown / 3.6) * 2.3;

  // hold C (or the touch eye button) to look back
  const wantBack = (G.state === 'RACE' && lookingBack()) ? 1 : 0;
  lookBack += (wantBack - lookBack) * Math.min(1, dt * 10);
  if (lookBack > 0.02) camAngle += Math.PI * lookBack;

  const speedRatio = clamp(Math.abs(p.speed) / CFG.topSpeed, 0, 1.6);
  const dist = CFG.camDist + speedRatio * 1.6;

  // swing the camera slightly to the outside of a drift
  const wantLat = (p.drift || 0) * -2.0;
  camLat += (wantLat - camLat) * Math.min(1, dt * 4);
  const sideX = -Math.sin(camAngle), sideZ = Math.cos(camAngle);

  const cx = p.x - Math.cos(camAngle) * dist + sideX * camLat;
  const cz = p.z - Math.sin(camAngle) * dist + sideZ * camLat;

  const camGround = track.query(cx, cz, p.sHint).groundY;
  const wantY = Math.max(camGround + 2.2, p.groundY + CFG.camHeight);

  const shake = G.cam.shake;
  const sx = shake > 0.01 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0.01 ? (Math.random() - 0.5) * shake : 0;

  // A single frame of position noise on the kart shows up as camera shake, so
  // low-pass the derived position. The time constant is short enough (~40ms)
  // that the camera never reads as lagging behind the kart.
  if (!camPos.live || Math.hypot(cx - camPos.x, cz - camPos.z) > 40) {
    camPos.x = cx; camPos.z = cz; camPos.live = true;
  } else {
    const ck = Math.min(1, dt * 25);
    camPos.x += (cx - camPos.x) * ck;
    camPos.z += (cz - camPos.z) * ck;
  }
  camera.position.set(camPos.x + sx, lerp(camera.position.y || wantY, wantY, Math.min(1, dt * 8)) + sy, camPos.z);
  const lx = p.x + Math.cos(camAngle) * CFG.camLookAhead;
  const lz = p.z + Math.sin(camAngle) * CFG.camLookAhead;
  camera.lookAt(lx, p.groundY + 2.4, lz);
  sun.follow(p.x, p.groundY, p.z);        // keep the shadow box on the action
  if (Math.abs(camLat) > 0.05) camera.rotateZ(camLat * 0.012);   // subtle roll into the drift

  const wantFov = fovBase + speedRatio * 6 + (p.boost > 0 ? 7 : 0);
  fov = lerp(fov, wantFov, Math.min(1, dt * 5));
  if (Math.abs(fov - camera.fov) > 0.05) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

// start-gate countdown lamps: red, red, red… green!
function updateGateLamps() {
  const track = attachedTrack;
  if (!track || !track.gateLamps) return;
  const RED = 0xd82f2f, GREEN = 0x2fd84f;
  let states = [0, 0, 0];
  if (G.state === 'COUNTDOWN') {
    const c = G.countdown;
    states = [c <= 2.6 ? RED : 0, c <= 1.7 ? RED : 0, c <= 0.8 ? RED : 0];
  } else if (G.state === 'RACE' && goTimer > 0) {
    states = [GREEN, GREEN, GREEN];
  }
  track.gateLamps.forEach((lm, i) => {
    lm.material.emissive.setHex(states[i]);
    lm.material.emissiveIntensity = states[i] ? 1.6 : 0;
  });
}

function menuCamera(time) {
  const track = attachedTrack;
  if (!track) return;
  const N = track.N;
  const f = (time * 16) % N;
  const i0 = Math.floor(f), t = f - i0;
  const a = track.samples[i0], b = track.samples[(i0 + 1) % N];
  const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t), y = lerp(a.y, b.y, t);
  const ahead = track.samples[(i0 + 14) % N];
  camera.position.set(x - a.tx * 26, y + 13, z - a.tz * 26);
  camera.lookAt(ahead.x, ahead.y + 3, ahead.z);
  sun.follow(x, y, z);
  if (camera.fov !== fovBase) {
    camera.fov = fovBase;
    camera.updateProjectionMatrix();
  }
}

// --- input handling per state --------------------------------------------------

function handleMenu() {
  let changed = false;
  if (wasPressed('ArrowDown') || wasPressed('s')) { menuSel = (menuSel + 1) % 6; changed = true; Sound.blip(440, 0.06); }
  if (wasPressed('ArrowUp') || wasPressed('w')) { menuSel = (menuSel + 5) % 6; changed = true; Sound.blip(440, 0.06); }
  const dir = (wasPressed('ArrowRight') || wasPressed('d')) ? 1 :
    ((wasPressed('ArrowLeft') || wasPressed('a')) ? -1 : 0);
  if (dir) { menuArrow(menuSel, dir); changed = true; }
  if (wasPressed('Enter') || wasPressed(' ')) {
    if (menuSel === 5) { Sound.blip(880, 0.12); startFlow(); return; }
    if (menuSel === 4) { Sound.blip(660, 0.1); enterEditor(); return; }
    if (menuSel === 3) { Sound.blip(660, 0.1); enterGarage(); return; }
    menuSel = 5; changed = true;
  }
  if (changed) updateMenu(menuSel);
}

// --- track lab -----------------------------------------------------------------

let editor = null;
let editorDef = null;
const HILL_LEVELS = [0, 8, 16, 24];
const HILL_NAMES = ['Flat', 'Rolling', 'Hilly', 'Mountains'];
const $id = (id) => document.getElementById(id);

function nearestHillIdx(a) {
  let bi = 0, bd = 1e9;
  HILL_LEVELS.forEach((h, i) => { const d = Math.abs(h - a); if (d < bd) { bd = d; bi = i; } });
  return bi;
}

function updateEditorLabels() {
  $id('edTheme').textContent = THEME_BASES[editorDef.themeIndex].label;
  $id('edHill').textContent = HILL_NAMES[nearestHillIdx(editorDef.elevAmp)];
}

function enterEditor() {
  if (!editor) {
    editor = new TrackEditor($id('edCanvas'), () => saveCustomDef(editorDef));
    $id('edThemePrev').addEventListener('click', () => edTheme(-1));
    $id('edThemeNext').addEventListener('click', () => edTheme(1));
    $id('edHillPrev').addEventListener('click', () => edHill(-1));
    $id('edHillNext').addEventListener('click', () => edHill(1));
    $id('edRandom').addEventListener('click', () => edRandom());
    $id('edTest').addEventListener('click', () => edRace());
  }
  // only write (and bump rev, invalidating the built track) for a brand-new one
  const existing = loadCustomDef();
  editorDef = existing || newCustomDef();
  if (!existing) saveCustomDef(editorDef);       // it now exists in the TRACK list
  editor.setDef(editorDef);
  updateEditorLabels();
  G.state = 'EDITOR';
  showScreen('editorScreen');
}

function edTheme(dir) {
  applyTheme(editorDef, (editorDef.themeIndex + dir + THEME_BASES.length) % THEME_BASES.length);
  saveCustomDef(editorDef);
  updateEditorLabels();
  Sound.blip(660, 0.06);
}

function edHill(dir) {
  editorDef.elevAmp = HILL_LEVELS[clamp(nearestHillIdx(editorDef.elevAmp) + dir, 0, HILL_LEVELS.length - 1)];
  saveCustomDef(editorDef);
  updateEditorLabels();
  Sound.blip(660, 0.06);
}

function edRandom() {
  editorDef.seed = (Math.random() * 0xffffffff) >>> 0;
  editorDef.points = generateLayout(editorDef.seed);
  saveCustomDef(editorDef);
  editor.render();
  Sound.blip(880, 0.08);
}

function edRace() {
  saveCustomDef(editorDef);
  if (G.mode === 1) G.mode = 0;      // cups run the built-in tracks
  G.trackIndex = trackCount() - 1;   // the custom track is always last
  attachTrack(G.trackIndex);
  G.gp = null;
  Sound.blip(880, 0.12);
  enterCharSel();
}

function handleEditor() {
  if (wasPressed('Escape') || wasPressed('Enter')) {
    G.state = 'MENU';
    showScreen('menu');
    updateMenu(menuSel);
  }
}

// Entering a race always goes through character select first.
function startFlow() {
  if (G.mode === 1) {
    G.gp = { race: 0, cast: null, points: [0, 0, 0, 0, 0, 0] };
    G.trackIndex = 0;
    attachTrack(0);
  } else {
    G.gp = null;
  }
  enterCharSel();
}

// --- garage ------------------------------------------------------------------

function enterGarage() {
  G.state = 'GARAGE';
  garageSel = { row: 0, col: Garage.equipped.engine };
  showScreen('garage');
  renderGarage(garageSel);
  showCharPreview();
  applyGaragePreview();
}

function applyGaragePreview() {
  if (!previewVisual) return;
  const m = Garage.mods();
  previewVisual.applyMods(m.tiers, m.paint, CHARACTERS[G.playerChar].palette.body);
}

function garageActivate(row, col) {
  garageSel = { row, col };
  if (row === 3) {
    Garage.setPaint(col);
    Sound.blip(760, 0.08);
  } else {
    const key = ['engine', 'tires', 'spoiler'][row];
    const res = Garage.buyOrEquip(key, col);
    if (res === 'poor') Sound.blip(170, 0.22, 'sawtooth', 0.16);
    else if (res === 'bought') Sound.pickup();
    else Sound.blip(760, 0.08);
  }
  renderGarage(garageSel);
  applyGaragePreview();
}

function handleGarage() {
  let ch = false;
  if (wasPressed('ArrowDown') || wasPressed('s')) { garageSel.row = (garageSel.row + 1) % 4; ch = true; }
  if (wasPressed('ArrowUp') || wasPressed('w')) { garageSel.row = (garageSel.row + 3) % 4; ch = true; }
  if (ch) garageSel.col = Math.min(garageSel.col, garageColCount(garageSel.row) - 1);
  const n = garageColCount(garageSel.row);
  if (wasPressed('ArrowRight') || wasPressed('d')) { garageSel.col = (garageSel.col + 1) % n; ch = true; }
  if (wasPressed('ArrowLeft') || wasPressed('a')) { garageSel.col = (garageSel.col + n - 1) % n; ch = true; }
  if (ch) { renderGarage(garageSel); Sound.blip(440, 0.05, 'square', 0.07); }
  if (wasPressed('Enter') || wasPressed(' ')) garageActivate(garageSel.row, garageSel.col);
  if (wasPressed('Escape')) {
    hideCharPreview();
    G.state = 'MENU';
    showScreen('menu');
    updateMenu(menuSel);
  }
}

function handleCharSel() {
  if (wasPressed('ArrowLeft') || wasPressed('a')) charSelDir(-1);
  if (wasPressed('ArrowRight') || wasPressed('d')) charSelDir(1);
  if (wasPressed('Enter') || wasPressed(' ')) { Sound.blip(880, 0.12); doStartRace(); return; }
  if (wasPressed('Escape')) {
    hideCharPreview();
    G.state = 'MENU';
    showScreen('menu');
    updateMenu(menuSel);
  }
}

function menuArrow(row, dir) {
  Sound.blip(660, 0.06);
  if (row === 0) {
    G.mode = (G.mode + dir + MODES.length) % MODES.length;
  } else if (row === 1 && G.mode !== 1) {
    G.trackIndex = (G.trackIndex + dir + trackCount()) % trackCount();
    attachTrack(G.trackIndex);
  } else if (row === 2 && G.mode !== 2) {
    G.difficulty = clamp(G.difficulty + dir, 0, DIFFICULTIES.length - 1);
  }
  savePrefs();
  updateMenu(menuSel);
}

function handlePause() {
  if (wasPressed('ArrowDown') || wasPressed('s')) { pauseSel = (pauseSel + 1) % 3; updatePause(pauseSel); }
  if (wasPressed('ArrowUp') || wasPressed('w')) { pauseSel = (pauseSel + 2) % 3; updatePause(pauseSel); }
  if (wasPressed('Escape') || wasPressed('p')) { togglePause(); return; }
  if (wasPressed('Enter') || wasPressed(' ')) pauseAction(pauseSel);
}

// YouTube pauses a Playable whenever it is backgrounded or covered by its own
// UI. Freeze then, and pick back up where the player left off — but only undo a
// pause we caused, so a system resume never yanks someone out of the pause menu
// they opened themselves.
let systemPaused = false;

function onSystemPause() {
  Store.flushNow();                 // last guaranteed moment to persist
  Sound.updateEngine(0, false, 0);
  Sound.suspend();
  if (G.state === 'RACE' || G.state === 'COUNTDOWN') {
    systemPaused = true;
    togglePause();
  }
}

function onSystemResume() {
  Sound.resume();
  if (systemPaused && G.state === 'PAUSE') togglePause();
  systemPaused = false;
}

// Escape/pause-button behaviour, shared by the key and the touch button.
function togglePause() {
  if (G.state === 'RACE' || G.state === 'COUNTDOWN') {
    prevState = G.state;
    G.state = 'PAUSE';
    pauseSel = 0;
    showScreen('pauseMenu');
    updatePause(0);
    Sound.updateEngine(0, false, 0);
  } else if (G.state === 'PAUSE') {
    G.state = prevState || 'RACE';
    showScreen('hud');
  }
}

// RESULTS: continue (next cup race / podium / rematch) and bail out.
function resultsContinue() {
  if (G.state !== 'RESULTS') return;
  if (G.mode === 1 && G.gp) {
    if (G.gp.race >= 5) { enterPodium(); return; }
    G.trackIndex = G.gp.race;
  }
  doStartRace();
}

function resultsQuit() {
  if (G.state !== 'RESULTS') return;
  G.gp = null;
  quitToMenu();
}

// The visible BACK buttons on character select / garage / track lab.
const BACK_FROM = { charBack: 'CHARSEL', garageBack: 'GARAGE', edBack: 'EDITOR' };
function screenBack(which) {
  if (G.state !== BACK_FROM[which]) return;
  hideCharPreview();               // no-op unless a preview kart is on screen
  G.state = 'MENU';
  showScreen('menu');
  updateMenu(menuSel);
}

function pauseAction(row) {
  systemPaused = false;             // the player took over this pause
  if (row === 0) { G.state = prevState || 'RACE'; showScreen('hud'); }
  else if (row === 1) doStartRace();
  else quitToMenu();
}

// --- boot ------------------------------------------------------------------------

initHUD();
initRace(scene);
bindMenuClicks(
  (row) => {
    menuSel = row;
    updateMenu(menuSel);
    if (row === 5) startFlow();
    else if (row === 4) enterEditor();
    else if (row === 3) enterGarage();
  },
  (row, dir) => menuArrow(row, dir),
);
bindPauseClicks((row) => pauseAction(row));
bindCharSelClicks((dir) => charSelDir(dir), () => doStartRace());
bindGarageClicks((row, col) => garageActivate(row, col));
Playables.onPauseResume(onSystemPause, onSystemResume);
Sound.setHostAudio(Playables.isAudioEnabled());
Playables.onAudioEnabledChange((on) => Sound.setHostAudio(on));
// surface anything that escapes to the frame loop, which is otherwise invisible
addEventListener('error', (e) => Playables.logError(e.message || 'error'));
addEventListener('unhandledrejection', (e) => Playables.logError('unhandled rejection: ' + (e.reason && e.reason.message)));
// the browser's own backgrounding deserves the same treatment
addEventListener('visibilitychange', () => {
  if (document.hidden) onSystemPause(); else onSystemResume();
});
bindScreenButtons({
  onBack: (id) => screenBack(id),
  onResultsAgain: () => resultsContinue(),
  onResultsMenu: () => resultsQuit(),
  onPodiumDone: () => exitPodium(),
});
initTouch({ onPause: () => togglePause() });

// remember mode/track/rivals/character/mute across visits
function savePrefs() {
  try {
    Store.set('kartrush2.prefs', JSON.stringify({
      mode: G.mode, trackIndex: G.trackIndex, difficulty: G.difficulty,
      playerChar: G.playerChar, muted: Sound.muted,
    }));
  } catch (e) { /* ignore */ }
}
try {
  const prefs = JSON.parse(Store.get('kartrush2.prefs'));
  if (prefs) {
    G.mode = clamp(prefs.mode | 0, 0, MODES.length - 1);
    G.trackIndex = clamp(prefs.trackIndex | 0, 0, trackCount() - 1);
    G.difficulty = clamp(prefs.difficulty | 0, 0, DIFFICULTIES.length - 1);
    G.playerChar = clamp(prefs.playerChar | 0, 0, CHARACTERS.length - 1);
    if (prefs.muted) setFirstInputHook(() => { Sound.init(); Sound.resume(); Sound.toggleMute(); });
  }
} catch (e) { /* fresh */ }

attachTrack(G.trackIndex);
setLoading(false);
showScreen('menu');
updateMenu(menuSel);
Playables.gameReady();

// --- main loop ---------------------------------------------------------------------

let last = performance.now();
let dtSmooth = 1 / 60;
let firstFrameSent = false;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 1 / 20) dt = 1 / 20;
  if (dt <= 0) dt = 1 / 240;
  // Frame intervals on a phone are noisy — missed vsync, GC, thermal steps.
  // Integrating that noise directly is what reads as jitter, so step the world
  // against a low-passed interval. A low-pass preserves the mean, so the race
  // clock still tracks the wall clock.
  dtSmooth += (dt - dtSmooth) * 0.25;
  dt = clamp(dtSmooth, 1 / 240, 1 / 20);
  const time = now / 1000;

  switch (G.state) {
    case 'MENU': {
      handleMenu();
      menuCamera(time);
      break;
    }

    case 'CHARSEL': {
      handleCharSel();
      menuCamera(time);
      poseCharPreview(time);
      break;
    }

    case 'GARAGE': {
      handleGarage();
      menuCamera(time);
      poseCharPreview(time);
      break;
    }

    case 'EDITOR': {
      handleEditor();
      menuCamera(time);
      break;
    }

    case 'COUNTDOWN': {
      const before = G.countdown;
      G.countdown -= dt;
      for (const step of [3.6, 2.6, 1.7, 0.8]) {
        if (before >= step && G.countdown < step) Sound.count(step === 0.8);
      }
      const t = G.countdown;
      setCountdown(t > 2.6 ? '3' : (t > 1.7 ? '2' : '1'));
      stepRace(dt);
      syncVisuals(dt, time);
      applyCamera(dt);
      updateHUD();
      updateGateLamps();
      if (G.countdown <= 0.8) {
        // GO! — controls unlock the moment the green shows
        setRevMode(false);
        G.state = 'RACE';
        G.time = 0;
        goTimer = 0.8;
        setCountdown('GO!');
        for (const r of G.racers) r.lapStart = 0;
        resolveRocketStart();
      }
      if (wasPressed('Escape') || wasPressed('p')) togglePause();
      break;
    }

    case 'RACE': {
      const sub = 2;
      for (let i = 0; i < sub; i++) stepRace(dt / sub);
      syncVisuals(dt, time);
      applyCamera(dt);
      updateHUD();
      if (goTimer > 0) {
        goTimer -= dt;
        if (goTimer <= 0) setCountdown('');
        updateGateLamps();
      }
      const p = G.racers[0];
      Sound.updateEngine(
        clamp(Math.abs(p.speed) / CFG.topSpeed, 0, 1.4), true,
        (p.drift !== 0 ? 0.8 : 0) + (p.q && p.q.onRoad ? 0 : 0.5));
      if (G.state === 'RESULTS') {           // player just finished
        setCountdown('');
        if (G.mode === 1) awardGpPoints();
        showResults();
        showScreen('resultsScreen');
        Sound.updateEngine(0, false, 0);
      }
      if (wasPressed('Escape') || wasPressed('p')) togglePause();
      if (wasPressed('r')) doStartRace();
      break;
    }

    case 'PAUSE': {
      handlePause();
      break;
    }

    case 'RESULTS': {
      // world keeps running behind the results panel; stragglers finish
      const before = G.racers.filter((r) => r.finished).length;
      stepRace(dt);
      syncVisuals(dt, time);
      applyCamera(dt);
      const after = G.racers.filter((r) => r.finished).length;
      if (after !== before) {
        if (G.mode === 1) awardGpPoints();      // re-price the race with the new order
        G.results = G.racers.slice().sort((a, b) => a.place - b.place);
        showResults();
      }
      if (wasPressed('Enter')) resultsContinue();
      if (wasPressed('Escape')) resultsQuit();
      break;
    }

    case 'PODIUM': {
      podiumTimer += dt;
      if (Math.random() < 0.45) {
        confettiBurst(podiumFocus.x, podiumFocus.y + 14, podiumFocus.z, 2);
      }
      syncVisuals(dt, time);
      // gentle arc in front of the podium instead of a full orbit, so the
      // three karts never line up behind one another
      const swing = Math.sin(podiumTimer * 0.35) * 0.42;
      const ax = podiumAxis.x * Math.cos(swing) - podiumAxis.z * Math.sin(swing);
      const az = podiumAxis.x * Math.sin(swing) + podiumAxis.z * Math.cos(swing);
      camera.position.set(
        podiumFocus.x + ax * 26,
        podiumFocus.y + 9 + Math.sin(podiumTimer * 0.25) * 1.5,
        podiumFocus.z + az * 26);
      camera.lookAt(podiumFocus.x, podiumFocus.y + 3.6, podiumFocus.z);
      if (wasPressed('Enter') || wasPressed('Escape')) {
        exitPodium();
      }
      break;
    }
  }

  if (rotateHintTimer > 0) {
    rotateHintTimer -= dt;
    updateRotateHint();
    if (rotateHintTimer <= 0) { rotateNudged = true; updateRotateHint(); }
  }

  if (wasPressed('m')) { Sound.toggleMute(); savePrefs(); }
  Sound.updateMusic();

  if (innerWidth > 0 && innerHeight > 0) rig.render();   // nothing to draw into yet
  if (!firstFrameSent) { firstFrameSent = true; Playables.firstFrameReady(); }
  clearPressed();
  adaptQuality(dt * 1000);      // dt is the real frame interval under rAF

  // fps stats
  stats.frames++;
  const el2 = now - stats.last;
  if (el2 > 1000) {
    stats.fps = stats.frames / (el2 / 1000);
    stats.frames = 0;
    stats.last = now;
  }
}

requestAnimationFrame(frame);

// --- test hooks -----------------------------------------------------------------------

window.__kr = {
  G, stepRace, syncVisuals, doStartRace, attachTrack,
  camera, renderer, scene, stats,
  applyCamera, updateHUD, showResults, showScreen,
  renderOnce: () => renderer.render(scene, camera),
  setAuto: (v) => { G.auto = v; },
  touch, readControls, togglePause, resultsContinue, rig, quality,
  Store, Playables, Sound, onSystemPause, onSystemResume,
  // Pump one frame by hand. Lets a headless harness run whole races
  // deterministically instead of waiting on requestAnimationFrame.
  tick: (ms = 1000 / 60) => frame(last + ms),
};
