// ---------------------------------------------------------------------------
// Track Lab: the dynamic track list (built-ins + daily challenge + the
// player's custom track), procedural layout generation, and custom persistence.
// ---------------------------------------------------------------------------
import { TRACK_DEFS } from './config.js';
import { TAU, clamp, mulberry32 } from './util.js';
import * as Store from './store.js';

const CUSTOM_KEY = 'kartrush2.customTrack';

// Base themes the generator / editor can dress a layout with.
// Each entry borrows theme + deco + hazard from a built-in track.
export const THEME_BASES = TRACK_DEFS.map((d) => ({
  label: d.name.split(' ')[0],           // Sunset / Coconut / Volcano / Frostbite / Neon
  theme: d.theme,
  deco: d.deco,
  hazard: d.hazard || null,
}));

// Generate a simple (non-self-crossing) closed blob of control points.
export function generateLayout(seed, n) {
  const rng = mulberry32(seed);
  const count = n || (12 + Math.floor(rng() * 5));
  const points = [];
  let r = 0.24 + rng() * 0.12;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + (rng() - 0.5) * (0.6 / count) * TAU;
    r = clamp(r + (rng() - 0.5) * 0.15, 0.16, 0.44);
    points.push([
      clamp(0.5 + Math.cos(a) * r * 1.05, 0.06, 0.94),
      clamp(0.5 + Math.sin(a) * r, 0.06, 0.94),
    ]);
  }
  return points;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- daily challenge ---------------------------------------------------------

export function makeDailyDef() {
  const now = new Date();
  const key = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
  const seed = hashString('kartrush-daily-' + key);
  const rng = mulberry32(seed ^ 0xbeef);
  const base = THEME_BASES[Math.floor(rng() * THEME_BASES.length)];
  const label = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return {
    name: 'Daily · ' + label,
    daily: true,
    seed,
    laps: 3,
    elevAmp: 8 + rng() * 14,
    deco: base.deco,
    hazard: base.hazard,
    points: generateLayout(seed),
    theme: base.theme,
  };
}

// --- custom track --------------------------------------------------------------

export function loadCustomDef() {
  try {
    const d = JSON.parse(Store.get(CUSTOM_KEY));
    if (d && d.points && d.points.length >= 8) {
      // re-attach the live theme object for its base
      const base = THEME_BASES[d.themeIndex] || THEME_BASES[0];
      return {
        name: 'My Track',
        custom: true,
        seed: d.seed || 4242,
        laps: 3,
        elevAmp: typeof d.elevAmp === 'number' ? d.elevAmp : 10,   // 0 = Flat is valid
        themeIndex: d.themeIndex || 0,
        deco: base.deco,
        hazard: base.hazard,
        points: d.points,
        theme: base.theme,
        rev: d.rev || 0,
      };
    }
  } catch (e) { /* none yet */ }
  return null;
}

export function saveCustomDef(def) {
  def.rev = (def.rev || 0) + 1;
  Store.set(CUSTOM_KEY, JSON.stringify({
    points: def.points,
    themeIndex: def.themeIndex,
    elevAmp: def.elevAmp,
    seed: def.seed,
    rev: def.rev,
  }));
}

export function newCustomDef() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const base = THEME_BASES[0];
  return {
    name: 'My Track',
    custom: true,
    seed,
    laps: 3,
    elevAmp: 10,
    themeIndex: 0,
    deco: base.deco,
    hazard: base.hazard,
    points: generateLayout(seed, 13),
    theme: base.theme,
    rev: 0,
  };
}

export function applyTheme(def, themeIndex) {
  const base = THEME_BASES[themeIndex];
  def.themeIndex = themeIndex;
  def.theme = base.theme;
  def.deco = base.deco;
  def.hazard = base.hazard;
}

// --- the selectable track list ---------------------------------------------------

let daily = null;
export function getTrackList() {
  if (!daily) daily = makeDailyDef();
  const list = TRACK_DEFS.slice();
  list.push(daily);
  const custom = loadCustomDef();
  if (custom) list.push(custom);
  return list;
}

export function getTrackDef(i) {
  const list = getTrackList();
  return list[clamp(i, 0, list.length - 1)];
}

export function trackCount() { return getTrackList().length; }
