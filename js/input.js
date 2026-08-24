// ---------------------------------------------------------------------------
// Keyboard + gamepad input.
// ---------------------------------------------------------------------------
import { clamp } from './util.js';

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
addEventListener('mousedown', () => {
  if (onFirstInput) { onFirstInput(); onFirstInput = null; }
});

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
  c.steer = clamp(c.steer, -1, 1);
  return c;
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
  return wasPressed(' ') || wasPressed('z') || padItemEdge();
}
