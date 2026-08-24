// ---------------------------------------------------------------------------
// Entry point.
//
// Every module reads its slice of save data at import time (the garage loads
// its wallet, main reads prefs), so the Playables cloud save has to be in
// localStorage before any of them run. Hydrate first, then import the game.
//
// The cloud is never allowed to hold the game hostage: if the SDK is missing,
// slow or broken, we boot on whatever is stored locally.
// ---------------------------------------------------------------------------
import { hydrate } from './store.js';

const HYDRATE_TIMEOUT = 3000;

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
