// ---------------------------------------------------------------------------
// Save data.
//
// Inside a Playable, certification is explicit: "Game MUST NOT use any other
// mechanism to save user progress." So there, localStorage is never touched —
// reads and writes go through an in-memory mirror hydrated from the cloud at
// boot, and the cloud save is the only persistence that exists.
//
// Served anywhere else there is no cloud, so localStorage is the store.
//
// Writes are debounced: finishing a race touches coins, best lap and ghost in
// the same frame, and that should be one upload, not three.
// ---------------------------------------------------------------------------
import { Playables } from './playables.js';

const PREFIX = 'kartrush2.';
const SYNC_DELAY = 1200;

// Decided once. IN_PLAYABLES_ENV is set by the SDK before any game code runs,
// so this cannot change underneath us mid-session.
let strictMode = null;
function isStrict() {
  if (strictMode === null) strictMode = Playables.inYouTube;
  return strictMode;
}

const mem = new Map();

// "Game MUST await loadData before calling saveData." Boot gives up waiting
// after a while so a broken cloud cannot hang the game, but a save must still
// never overtake the load — it would write freshly-defaulted state over real
// progress.
let loadDone = false;
let loadWaiters = [];
function whenLoaded() {
  return loadDone ? Promise.resolve() : new Promise((r) => loadWaiters.push(r));
}
function markLoadDone() {
  if (loadDone) return;
  loadDone = true;
  loadWaiters.splice(0).forEach((r) => r());
}

let syncTimer = null;
let syncing = false;
let dirtyAgain = false;
let lateHydrate = null;

export function get(key) {
  if (isStrict()) return mem.has(key) ? mem.get(key) : null;
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function set(key, value) {
  if (isStrict()) mem.set(key, String(value));
  else {
    try { localStorage.setItem(key, value); } catch (e) { /* quota or private mode */ }
  }
  scheduleSync();
}

export function remove(key) {
  if (isStrict()) mem.delete(key);
  else {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  scheduleSync();
}

// Every kartrush2.* key as one plain object.
function snapshot() {
  const out = {};
  if (isStrict()) {
    for (const [k, v] of mem) if (k.startsWith(PREFIX)) out[k] = v;
    return out;
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k);
    }
  } catch (e) { /* ignore */ }
  return out;
}

function scheduleSync() {
  if (!Playables.available) return;
  if (syncing) { dirtyAgain = true; return; }
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(flush, SYNC_DELAY);
}

async function flush() {
  syncTimer = null;
  await whenLoaded();              // never overtake loadData
  syncing = true;
  await Playables.save(snapshot());
  syncing = false;
  if (dirtyAgain) { dirtyAgain = false; scheduleSync(); }
}

// Push immediately, without waiting out the debounce. Called when YouTube
// pauses us, which is the last moment we are guaranteed to run.
export function flushNow() {
  if (!Playables.available) return;
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  flush();
}

// Registered by the game so that a cloud save which arrives after boot gave up
// waiting can still be applied, instead of leaving the player staring at
// defaults for the rest of the session.
export function onLateHydrate(cb) { lateHydrate = cb; }

let bootDone = false;
export function markBootComplete() { bootDone = true; }

// Pull the cloud save in before any module reads its slice. Cloud wins on
// conflict: it is the account-level record. A missing or unreadable save leaves
// whatever is already there untouched. Keys outside our namespace are refused.
export async function hydrate() {
  if (!Playables.available) { markLoadDone(); return false; }
  let wrote = 0;
  try {
    const cloud = await Playables.load();
    if (cloud) {
      for (const k of Object.keys(cloud)) {
        if (!k.startsWith(PREFIX)) continue;
        const v = cloud[k];
        if (typeof v !== 'string') continue;
        if (isStrict()) { mem.set(k, v); wrote++; } else {
          try { localStorage.setItem(k, v); wrote++; } catch (e) { /* ignore */ }
        }
      }
    }
  } finally {
    markLoadDone();
  }
  // arrived after boot moved on: let the game re-read what it already loaded
  if (wrote > 0 && bootDone && lateHydrate) {
    try { lateHydrate(); } catch (e) { /* never let this break the game */ }
  }
  return wrote > 0;
}

// Test seam: lets a harness inspect which mechanism is actually in use.
export function _debug() {
  return { strict: isStrict(), memKeys: mem.size, loadDone };
}
