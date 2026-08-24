// ---------------------------------------------------------------------------
// Keyboard + gamepad input.
// ---------------------------------------------------------------------------
import { clamp } from './util.js';
import { touch, takeItemEdge } from './touch.js';

export const keys = {};
const pressed = {};
const HELD = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Shift'];

let onFirstInput = null;
export function setFirstInputHook(fn) { onFirstInput = fn; }

function normKey(e) {
  if (e.key === 'Shift') return 'Shift';
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}

addEventListener('keydown', (e) => {
  const k = normKey(e);
  if (!keys[k]) pressed[k] = true;
  keys[k] = true;
  if (HELD.indexOf(k) >= 0 || k === 'Enter') e.preventDefault();
  if (onFirstInput) { onFirstInput(); onFirstInput = null; }
});
addEventListener('keyup', (e) => { keys[normKey(e)] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
// Any first gesture unlocks WebAudio. `pointerdown` covers mouse, touch and
// pen; `touchstart` is the belt-and-braces fallback for older mobile Safari,
// where a pointerdown can arrive too late to count as the unlocking gesture.
const firstGesture = () => {
  if (onFirstInput) { onFirstInput(); onFirstInput = null; }
};
addEventListener('pointerdown', firstGesture);
addEventListener('touchstart', firstGesture, { passive: true });

export function wasPressed(k) { return !!pressed[k]; }
export function clearPressed() { for (const k in pressed) delete pressed[k]; }

function pad() {
  if (!navigator.getGamepads) return null;
  const gs = navigator.getGamepads();
  for (let i = 0; i < gs.length; i++) if (gs[i] && gs[i].connected) return gs[i];
  return null;
}

export function readControls() {
  const c = { steer: 0, gas: false, brake: false, drift: false, item: false };
  if (keys['ArrowLeft'] || keys['a']) c.steer -= 1;
  if (keys['ArrowRight'] || keys['d']) c.steer += 1;
  if (keys['ArrowUp'] || keys['w']) c.gas = true;
  if (keys['ArrowDown'] || keys['s']) c.brake = true;
  if (keys['Shift'] || keys['x']) c.drift = true;
  if (keys[' '] || keys['z']) c.item = true;

  const g = pad();
  if (g) {
    const ax = g.axes[0] || 0;
    if (Math.abs(ax) > 0.15) c.steer = clamp(c.steer + ax, -1, 1);
    const b = g.buttons;
    if (b[0]?.pressed || (b[7] && b[7].value > 0.3)) c.gas = true;
    if (b[1]?.pressed || (b[6] && b[6].value > 0.3)) c.brake = true;
    if (b[4]?.pressed || b[5]?.pressed) c.drift = true;
    if (b[2]?.pressed || b[3]?.pressed) c.item = true;
    if (b[12]?.pressed) c.gas = true;
  }
  if (touch.active) {
    if (touch.steer !== 0) c.steer = clamp(c.steer + touch.steer, -1, 1);
    // auto-accelerate frees the right thumb for drift/item; braking still wins
    if (touch.autoGas ? !touch.brake : touch.gas) c.gas = true;
    if (touch.brake) c.brake = true;
    if (touch.drift) c.drift = true;
    if (touch.item) c.item = true;
  }

  c.steer = clamp(c.steer, -1, 1);
  return c;
}

// Genuine "hold the gas" input for the rocket start. Auto-accelerate must not
// count, or every touch start would read as a 3.6-second bog; the touch layer
// surfaces a REV button during the countdown instead.
export function revving() {
  if (keys['ArrowUp'] || keys['w']) return true;
  const g = pad();
  if (g && (g.buttons[0]?.pressed || (g.buttons[7] && g.buttons[7].value > 0.3) ||
    g.buttons[12]?.pressed)) return true;
  return !!(touch.active && touch.gas);
}

// True while the player is holding the look-behind control.
export function lookingBack() {
  return !!(keys['c'] || keys['v'] || (touch.active && touch.look));
}

// Edge detector for the gamepad item button (space/z edges come from pressed{}).
let lastPadItem = false;
export function padItemEdge() {
  const g = pad();
  if (!g) return false;
  const now = !!(g.buttons[2]?.pressed || g.buttons[3]?.pressed);
  const edge = now && !lastPadItem;
  lastPadItem = now;
  return edge;
}

export function itemPressed() {
  // every edge detector must tick each frame, so evaluate before combining
  const pad = padItemEdge();
  const tap = takeItemEdge();
  return wasPressed(' ') || wasPressed('z') || pad || tap;
}
