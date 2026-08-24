// ---------------------------------------------------------------------------
// YouTube Playables SDK bridge.
//
// The SDK is loaded from youtube.com and deliberately no-ops when the game is
// served anywhere else, so every call here is guarded twice: once on whether
// the global exists at all, and once with try/catch. Kart Rush has to run
// identically from a plain static host, which is how it is developed.
// ---------------------------------------------------------------------------

const sdk = () => (typeof window !== 'undefined' ? window.ytgame : undefined);

export const Playables = {
  get available() { return !!sdk(); },

  // True only inside a real YouTube embed. The SDK reports this itself; treat a
  // missing flag as "not in YouTube" rather than assuming.
  get inYouTube() {
    const g = sdk();
    try { return !!(g && g.IN_PLAYABLES_ENV); } catch (e) { return false; }
  },

  // --- lifecycle -------------------------------------------------------------

  // Tell YouTube the first frame has rendered, so it can drop its loading UI.
  firstFrameReady() {
    const g = sdk();
    try { if (g && g.game && g.game.firstFrameReady) g.game.firstFrameReady(); } catch (e) { /* no-op host */ }
  },

  // Tell YouTube the game is interactive.
  gameReady() {
    const g = sdk();
    try { if (g && g.game && g.game.gameReady) g.game.gameReady(); } catch (e) { /* no-op host */ }
  },

  // YouTube pauses a Playable when it is backgrounded, scrolled away from, or
  // covered by its own UI. Freezing is not optional: an unpaused race keeps
  // burning the player's battery behind a closed panel.
  onPauseResume(onPause, onResume) {
    const g = sdk();
    try {
      if (g && g.system && g.system.onPause) g.system.onPause(() => onPause());
      if (g && g.system && g.system.onResume) g.system.onResume(() => onResume());
    } catch (e) { /* no-op host */ }
  },

  // --- host audio policy ------------------------------------------------------
  // YouTube decides whether a Playable may make noise (autoplay policy, the
  // viewer's own mute) and can change that mid-session. Ignoring it is a good
  // way to fail certification.

  isAudioEnabled() {
    const g = sdk();
    try {
      if (g && g.system && g.system.isAudioEnabled) return !!g.system.isAudioEnabled();
    } catch (e) { /* no-op host */ }
    return true;              // no host opinion: the player's mute rules
  },

  onAudioEnabledChange(cb) {
    const g = sdk();
    try {
      if (g && g.system && g.system.onAudioEnabledChange) g.system.onAudioEnabledChange((on) => cb(!!on));
    } catch (e) { /* no-op host */ }
  },

  // --- diagnostics ------------------------------------------------------------
  // Errors inside a Playable are invisible otherwise; the host collects these.

  logError(message) {
    const g = sdk();
    try { if (g && g.health && g.health.logError) g.health.logError(String(message)); } catch (e) { /* ignore */ }
  },

  // --- cloud save ------------------------------------------------------------

  // Resolves to the parsed save object, or null when there is nothing stored
  // (or no SDK at all). Never rejects — a failed load must fall back to the
  // local copy rather than wiping progress.
  async load() {
    const g = sdk();
    if (!g || !g.game || !g.game.loadData) return null;
    try {
      const raw = await g.game.loadData();
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
      return null;
    }
  },

  // Resolves true on success. Never rejects, for the same reason.
  async save(obj) {
    const g = sdk();
    if (!g || !g.game || !g.game.saveData) return false;
    try {
      await g.game.saveData(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  },

  // --- ads -------------------------------------------------------------------

  get adsAvailable() {
    const g = sdk();
    try { return !!(g && g.ads && g.ads.requestRewardedAd && this.inYouTube); } catch (e) { return false; }
  },

  async interstitial() {
    const g = sdk();
    if (!g || !g.ads || !g.ads.requestInterstitialAd) return false;
    try { await g.ads.requestInterstitialAd(); return true; } catch (e) { return false; }
  },

  // Resolves { shown, result } and never rejects.
  //
  // Only AdResult.SHOWED earns a reward — DISMISSED and REJECTED must not, or
  // the reward becomes "tap the button and skip". The one genuinely uncertain
  // case is an SDK that resolves nothing at all: treating that as unwatched
  // would cheat a player who really did sit through an ad, so it counts only
  // when the SDK also exposes no AdResult enum to have reported with.
  async rewarded(id) {
    const g = sdk();
    if (!g || !g.ads || !g.ads.requestRewardedAd) {
      return { shown: false, result: 'unavailable' };
    }
    try {
      const res = await g.ads.requestRewardedAd(id);
      const AdResult = g.ads.AdResult;
      let shown;
      if (AdResult && AdResult.SHOWED !== undefined) {
        shown = res === AdResult.SHOWED || res === 'SHOWED';
      } else {
        shown = res === undefined || res === null ? true : !!res;
      }
      return { shown, result: String(res) };
    } catch (e) {
      return { shown: false, result: 'error', error: e && e.message };
    }
  },
};

