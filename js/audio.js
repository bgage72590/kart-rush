// ---------------------------------------------------------------------------
// WebAudio: synthesised engine, tyre skid, one-shot effects, and a small
// chiptune loop. Everything is generated — no asset files.
// ---------------------------------------------------------------------------

export const Sound = {
  ctx: null,
  master: null,
  musicBus: null,
  muted: false,          // the player's own mute (M key)
  hostAudio: true,       // YouTube can disable audio for the whole Playable
  started: false,
  engine: null,
  skid: null,
  music: { on: true, next: 0, step: 0, rush: false },

  init() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.42;
    this.musicBus.connect(this.master);
    this.started = true;
    this._buildEngine();
    this._buildSkid();
    this.music.next = this.ctx.currentTime + 0.1;
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },

  // Backgrounded by the host (a Playables pause, a hidden tab): stop the engine
  // loop and the music scheduler outright rather than leaving them running.
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  },

  // Two independent gates: the player's mute and the host's. Either one wins.
  get silent() { return this.muted || !this.hostAudio; },

  _applyGain() {
    if (this.master) this.master.gain.value = this.silent ? 0 : 0.5;
  },

  toggleMute() {
    this.muted = !this.muted;
    this._applyGain();
    return this.muted;
  },

  // YouTube reports whether audio is allowed and can change its mind mid-game.
  setHostAudio(on) {
    this.hostAudio = !!on;
    this._applyGain();
  },

  _noiseBuffer(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },

  _buildEngine() {
    const c = this.ctx;
    const gain = c.createGain();
    gain.gain.value = 0;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 4;
    const o1 = c.createOscillator(); o1.type = 'sawtooth';
    const o2 = c.createOscillator(); o2.type = 'square'; o2.detune.value = -12;
    o1.connect(filter); o2.connect(filter);
    filter.connect(gain); gain.connect(this.master);
    o1.start(); o2.start();
    this.engine = { o1, o2, gain, filter };
  },

  _buildSkid() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noiseBuffer(2);
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.value = 0;
    src.connect(bp); bp.connect(gain); gain.connect(this.master);
    src.start();
    this.skid = { gain, bp };
  },

  updateEngine(speed, running, skidAmt) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const e = this.engine;
    const f = 50 + speed * 205;
    e.o1.frequency.setTargetAtTime(f, t, 0.05);
    e.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    e.filter.frequency.setTargetAtTime(500 + speed * 2200, t, 0.08);
    e.gain.gain.setTargetAtTime(running ? 0.05 + speed * 0.045 : 0, t, 0.1);
    this.skid.gain.gain.setTargetAtTime(skidAmt * 0.06, t, 0.05);
  },

  // --- one-shots -------------------------------------------------------------

  blip(freq, dur, type, vol) {
    if (!this.started || this.silent) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol == null ? 0.18 : vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  sweep(from, to, dur, vol) {
    if (!this.started || this.silent) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol == null ? 0.14 : vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },

  noiseBurst(dur, freq, vol) {
    if (!this.started || this.silent) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this._noiseBuffer(dur + 0.05);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * 3, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol == null ? 0.25 : vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.05);
  },

  pickup() { this.blip(880, 0.09, 'square', 0.13); setTimeout(() => this.blip(1320, 0.1, 'square', 0.12), 70); },
  pop() { this.blip(680, 0.1, 'sine', 0.2); setTimeout(() => this.blip(920, 0.12, 'sine', 0.14), 60); },
  coin() { this.blip(1245, 0.06, 'square', 0.1); setTimeout(() => this.blip(1660, 0.14, 'square', 0.09), 55); },
  zap() { this.sweep(1400, 140, 0.45, 0.16); this.noiseBurst(0.3, 2400, 0.12); },
  hook() { this.sweep(280, 980, 0.22, 0.13); },
  boom() { this.noiseBurst(0.6, 90, 0.38); this.blip(70, 0.45, 'sawtooth', 0.22); },
  trick() { this.blip(740, 0.08, 'triangle', 0.14); setTimeout(() => this.blip(1100, 0.1, 'triangle', 0.13), 70); },
  taunt(pitch) {
    const p = pitch || 1;
    this.blip(460 * p, 0.09, 'square', 0.12);
    setTimeout(() => this.blip(340 * p, 0.08, 'square', 0.1), 90);
    setTimeout(() => this.blip(560 * p, 0.12, 'square', 0.12), 180);
  },
  boost() { this.noiseBurst(0.45, 320, 0.28); this.sweep(220, 900, 0.35, 0.09); },
  throwItem() { this.sweep(700, 240, 0.2, 0.11); },
  hit() { this.noiseBurst(0.35, 160, 0.3); this.blip(90, 0.3, 'sawtooth', 0.18); },
  bump() { this.blip(140, 0.08, 'square', 0.1); },
  count(final) { this.blip(final ? 880 : 520, final ? 0.35 : 0.14, 'square', 0.2); },
  lap() { [660, 880, 1100].forEach((f, i) => setTimeout(() => this.blip(f, 0.14, 'triangle', 0.15), i * 90)); },
  finish(win) {
    const notes = win ? [523, 659, 784, 1047, 1319] : [523, 494, 440, 392];
    notes.forEach((f, i) => setTimeout(() => this.blip(f, 0.3, 'triangle', 0.17), i * 150));
  },

  // --- music -----------------------------------------------------------------

  _note(freq, t, dur, type, vol) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.musicBus);
    o.start(t); o.stop(t + dur + 0.03);
  },

  _hat(t) {
    const c = this.ctx;
    if (!this._hatBuf) this._hatBuf = this._noiseBuffer(0.05);
    const s = c.createBufferSource();
    s.buffer = this._hatBuf;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const g = c.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    s.connect(f); f.connect(g); g.connect(this.musicBus);
    s.start(t); s.stop(t + 0.06);
  },

  updateMusic() {
    if (!this.started || this.silent || !this.music.on) return;
    const c = this.ctx;
    // resync after mute or a backgrounded tab instead of scheduling a burst
    if (this.music.next < c.currentTime - 0.1) this.music.next = c.currentTime + 0.05;
    const eighth = (60 / 148 / 2) / (this.music.rush ? 1.09 : 1);   // final lap speeds up
    const roots = [261.63, 220.0, 174.61, 196.0];    // C  Am  F  G
    const pent = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
    const pat = [0, 2, 4, -1, 3, -1, 4, 2];          // -1 = rest
    while (this.music.next < c.currentTime + 0.3) {
      const s = this.music.step;
      const t = this.music.next;
      const root = roots[(s >> 3) % 4];
      this._note(s % 2 ? root * 0.75 : root * 0.5, t, eighth * 0.9, 'triangle', 0.11);
      const p = pat[s % 8];
      if (p >= 0) this._note(root * 2 * pent[p], t, eighth * 0.75, 'square', 0.028);
      if (s % 2 === 0) this._hat(t + eighth * 0.5);
      this.music.step = (s + 1) % 32;
      this.music.next += eighth;
    }
  },
};
