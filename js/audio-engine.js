// Owns the AudioContext: loads song stems, plays them in sync, and turns context time into song time.

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.buffers = new Map();
    this.playing = null;
    this.workletReady = this.ctx.audioWorklet.addModule(new URL('./worklets/pitch-processor.js', import.meta.url));
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  load(url) {
    if (!this.buffers.has(url)) {
      const p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
          return r.arrayBuffer();
        })
        .then((b) => this.ctx.decodeAudioData(b));
      this.buffers.set(url, p);
      p.catch(() => this.buffers.delete(url));
    }
    return this.buffers.get(url);
  }

  // Seconds between scheduling audio and it leaving the speakers.
  get outputLatency() {
    return this.ctx.outputLatency || this.ctx.baseLatency || 0;
  }

  // Starts instrumental + guide vocal together a moment from now; returns the context start time.
  play({ inst, vocals, guide, offset = 0 }) {
    this.stop();
    const at = this.ctx.currentTime + 0.15;
    const make = (buffer, gain) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.master);
      src.start(at, offset);
      return { src, g };
    };
    const instTrack = make(inst, 1);
    const vocalTrack = make(vocals, guide);
    this.playing = { at: at - offset, inst: instTrack, vocals: vocalTrack, pausedAt: null, duration: inst.duration };
    return this.playing.at;
  }

  setGuide(level) {
    if (this.playing) this.playing.vocals.g.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05);
  }

  // Song time the listener hears right now (accounts for output latency).
  heardTime() {
    if (!this.playing) return 0;
    if (this.playing.pausedAt != null) return this.playing.pausedAt;
    return this.ctx.currentTime - this.playing.at - this.outputLatency;
  }

  // Converts a context timestamp of captured audio into the song time the singer was hearing.
  songTimeOf(contextTime, inputLatency) {
    return contextTime - inputLatency - this.playing.at - this.outputLatency;
  }

  async pause() {
    if (!this.playing || this.playing.pausedAt != null) return;
    this.playing.pausedAt = this.heardTime();
    await this.ctx.suspend();
  }

  async unpause() {
    if (!this.playing || this.playing.pausedAt == null) return;
    this.playing.pausedAt = null;
    await this.ctx.resume();
  }

  stop() {
    if (!this.playing) return;
    for (const t of [this.playing.inst, this.playing.vocals]) {
      try { t.src.stop(); } catch {}
      t.src.disconnect();
    }
    this.playing = null;
  }

  // A short UI sound: a soft sine blip.
  blip(freq = 880, dur = 0.08, vol = 0.08) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
