// ---------------------------------------------------------------------------
// Entry point.
//
// Every module reads its slice of save data at import time (the garage loads
// its wallet, main reads prefs), so the cloud save has to be in the store
// before any of them run. Hydrate first, then import the game.
// ---------------------------------------------------------------------------
import { hydrate, markBootComplete } from './store.js';

// Generous, because certification requires awaiting loadData and a real cloud
// round-trip is well under a second. If it does expire, the game still boots on
// defaults — and the store keeps every save blocked until the load lands, so a
// late arrival can never be clobbered by one.
const HYDRATE_TIMEOUT = 10000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

try {
  await withTimeout(hydrate(), HYDRATE_TIMEOUT);
} catch (e) {
  /* local save stands */
}

await import('./main.js');
markBootComplete();
