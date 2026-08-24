// ---------------------------------------------------------------------------
// Touch controls: a floating analog steering thumb on the left, an action
// cluster on the right, and the small HUD buttons (pause / look back) that a
// keyboard gets for free.
//
// Touch mode arms itself on the first real touch and disarms on the first key
// press, so a laptop with a touchscreen never gets a permanent overlay.
//
// Driving with two thumbs means the right one is already busy holding gas, so
// touch defaults to auto-accelerate — the standard for mobile kart racers. The
// AUTO pill switches to a manual gas button for anyone who wants it.
// ---------------------------------------------------------------------------
import { clamp } from './util.js';
import * as Store from './store.js';

export const touch = {
  active: false,        // touch mode engaged (first touch seen)
  autoGas: true,
  steer: 0,
  gas: false,           // manual-mode gas button
  brake: false,
  drift: false,
  item: false,
  look: false,
  _itemEdge: false,
};

const $ = (id) => document.getElementById(id);

const STEER_TRAVEL = 80;      // px of thumb travel for full lock
// Ring radius 61 minus knob radius 27: any more and the knob rides outside the
// ring at full lock. Keep in step with #tStick / #tKnob in the stylesheet.
const KNOB_TRAVEL = 34;       // px the visual knob is allowed to move
const STEER_EXPO = 1.6;       // >1 softens small corrections, keeps full lock
const STEER_DEAD = 0.05;      // ignore thumb tremor around centre

let els = null;
let steerId = -1, steerOriginX = 0;
let onModeChange = null;
let wantVisible = false;      // what the screen asked for, independent of mode

export function isTouchDevice() {
  return (navigator.maxTouchPoints || 0) > 0 ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
}

// --- mode arming ---------------------------------------------------------------

export function setTouchMode(on) {
  if (touch.active === on) return;
  touch.active = on;
  document.body.classList.toggle('touch', on);
  if (!on) releaseAll();
  // A player whose first touch lands mid-race armed the mode after the HUD
  // asked for controls — re-apply, or the pedals never appear.
  applyVisible();
  if (onModeChange) onModeChange(on);
}

function releaseAll() {
  touch.steer = 0;
  touch.gas = touch.brake = touch.drift = touch.item = touch.look = false;
  touch._itemEdge = false;
  steerId = -1;
  if (els) {
    els.knob.style.transform = 'translateX(0)';
    els.stick.classList.remove('on');
    for (const b of els.buttons) b.el.classList.remove('on');
  }
}

// Pointer capture keeps a thumb that slides off the button still bound to it.
// Both calls throw if the pointer id is already gone, which is routine on a
// fast tap, so neither is allowed to escape.
function capture(el, id) {
  try { el.setPointerCapture(id); } catch (e) { /* pointer already released */ }
}
function release(el, id) {
  try {
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
  } catch (e) { /* pointer already released */ }
}

// --- per-button plumbing --------------------------------------------------------

function bindButton(el, key, opts = {}) {
  const set = (v) => {
    touch[key] = v;
    el.classList.toggle('on', v);
    if (v && opts.edge) touch._itemEdge = true;
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(el, e.pointerId);
    set(true);
  });
  const up = (e) => {
    release(el, e.pointerId);
    set(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  // a pointer that leaves the button without releasing must not stick on
  el.addEventListener('lostpointercapture', () => set(false));
  return { el, set };
}

// --- steering -------------------------------------------------------------------

// Raw thumb offset drives the knob so it tracks the finger exactly, but the
// steering value gets an exponential curve: a linear stick makes a kart twitchy,
// because the corrections you make most often are the small ones.
function steerTo(clientX) {
  const raw = clamp((clientX - steerOriginX) / STEER_TRAVEL, -1, 1);
  const mag = Math.abs(raw);
  touch.steer = mag < STEER_DEAD ? 0 : Math.sign(raw) * Math.pow(mag, STEER_EXPO);
  els.knob.style.transform = 'translateX(' + (raw * KNOB_TRAVEL).toFixed(1) + 'px)';
}

function bindSteer() {
  const zone = els.zone, stick = els.stick;
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (steerId !== -1) return;
    steerId = e.pointerId;
    capture(zone, e.pointerId);
    steerOriginX = e.clientX;
    // the stick materialises under the thumb rather than at a fixed spot
    stick.style.left = e.clientX + 'px';
    stick.style.top = e.clientY + 'px';
    stick.classList.add('on');
    steerTo(e.clientX);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steerId) return;
    e.preventDefault();
    steerTo(e.clientX);
  });
  const up = (e) => {
    if (e.pointerId !== steerId) return;
    steerId = -1;
    touch.steer = 0;
    stick.classList.remove('on');
    els.knob.style.transform = 'translateX(0)';
  };
  zone.addEventListener('pointerup', up);
  zone.addEventListener('pointercancel', up);
  zone.addEventListener('lostpointercapture', () => {
    steerId = -1;
    touch.steer = 0;
    stick.classList.remove('on');
    els.knob.style.transform = 'translateX(0)';
  });
}

// --- init --------------------------------------------------------------------------

// onPause is called when the touch pause button is tapped.
export function initTouch({ onPause, onModeChange: modeCb } = {}) {
  onModeChange = modeCb || null;
  els = {
    root: $('touchControls'),
    zone: $('tSteerZone'),
    stick: $('tStick'),
    knob: $('tKnob'),
    auto: $('tAuto'),
    gas: $('tGas'),
    buttons: [],
  };
  if (!els.root) return;

  els.buttons.push(bindButton($('tDrift'), 'drift'));
  els.buttons.push(bindButton($('tBrake'), 'brake'));
  els.buttons.push(bindButton($('tItem'), 'item', { edge: true }));
  els.buttons.push(bindButton($('tGas'), 'gas'));
  els.buttons.push(bindButton($('tLook'), 'look'));
  bindSteer();

  $('tPause').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (onPause) onPause();
  });

  els.auto.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setAutoGas(!touch.autoGas);
    savePref();
  });

  loadPref();
  applyAutoGas();
  applyVisible();

  // arm on the first genuine touch, disarm on the first key press
  addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') setTouchMode(true);
  }, { capture: true });
  addEventListener('keydown', () => setTouchMode(false), { capture: true });
  if (isTouchDevice() && !matchMedia('(pointer: fine)').matches) setTouchMode(true);
}

export function setAutoGas(on) {
  touch.autoGas = !!on;
  applyAutoGas();
}

let revMode = false;

function applyAutoGas() {
  if (!els) return;
  els.auto.classList.toggle('on', touch.autoGas);
  els.auto.textContent = touch.autoGas ? 'AUTO' : 'MANUAL';
  const showGas = !touch.autoGas || revMode;
  els.gas.classList.toggle('hidden', !showGas);
  els.gas.textContent = revMode ? 'REV' : 'GAS';
  els.gas.classList.toggle('rev', revMode);
  if (!showGas) touch.gas = false;
}

// The countdown borrows the gas button as a REV button so auto-accelerate
// players can still nail (or blow) a rocket start.
export function setRevMode(on) {
  if (revMode === on) return;
  revMode = on;
  if (!on) touch.gas = false;
  applyAutoGas();
}

function savePref() {
  Store.set('kartrush2.autoGas', touch.autoGas ? '1' : '0');
}
function loadPref() {
  const v = Store.get('kartrush2.autoGas');
  if (v != null) touch.autoGas = v === '1';
}

// Show the driving controls only while actually driving.
export function showTouchControls(on) {
  wantVisible = on;
  applyVisible();
}

function applyVisible() {
  if (!els) return;
  const want = wantVisible && touch.active;
  if (want === !els.root.classList.contains('hidden')) return;
  els.root.classList.toggle('hidden', !want);
  if (!want) releaseAll();
}

// Consume the one-shot item tap (mirrors wasPressed/clearPressed for keys).
export function takeItemEdge() {
  const e = touch._itemEdge;
  touch._itemEdge = false;
  return e;
}
