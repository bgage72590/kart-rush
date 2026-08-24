// ---------------------------------------------------------------------------
// Save data. localStorage stays the working store — it is synchronous, which
// the rest of the game assumes — and the whole `kartrush2.*` namespace is
// mirrored to the Playables cloud save so progress follows the player's
// account instead of the browser they happened to use.
//
// Writes are debounced: a race finish can touch coins, best lap and ghost in
// the same frame, and that should be one upload, not three.
// ---------------------------------------------------------------------------
import { Playables } from './playables.js';

const PREFIX = 'kartrush2.';
const SYNC_DELAY = 1200;

let syncTimer = null;
let syncing = false;
let dirtyAgain = false;

export function get(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function set(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* quota or private mode */ }
  scheduleSync();
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  scheduleSync();
}

// Every kartrush2.* key as one plain object.
function snapshot() {
  const out = {};
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

// Pull the cloud save into localStorage before any module reads it. Cloud wins
// on conflict: it is the account-level record, and the local copy may belong to
// a device the player has since abandoned. A missing or unreadable cloud save
// leaves whatever is already local untouched.
export async function hydrate() {
  if (!Playables.available) return false;
  const cloud = await Playables.load();
  if (!cloud) return false;
  let n = 0;
  for (const k of Object.keys(cloud)) {
    if (!k.startsWith(PREFIX)) continue;          // never write outside our namespace
    const v = cloud[k];
    if (typeof v !== 'string') continue;
    try { localStorage.setItem(k, v); n++; } catch (e) { /* ignore */ }
  }
  return n > 0;
}
