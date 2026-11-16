// @ts-check
// Owns the AudioContext: loads song tracks, plays them in sync, and turns context time into song time.

const KEEP = 3; // decoded tracks kept for a restart: the music, the original vocal and a test recording

export class AudioEngine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    /** @type {Map<string, Promise<AudioBuffer>>} most recently used last */
    this.buffers = new Map();
    /** @type {{ at: number, pausedAt: number | null, sources: AudioBufferSourceNode[] } | null} */
    this.playing = null;
    this.workletReady = this.ctx.audioWorklet.addModule(new URL('./worklets/pitch-processor.js', import.meta.url));
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** @param {string} url */
  load(url) {
    let p = this.buffers.get(url);
    this.buffers.delete(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
          return r.arrayBuffer();
        })
        .then((b) => this.ctx.decodeAudioData(b));
      p.catch(() => this.buffers.delete(url));
    }
    this.buffers.set(url, p);
    for (const old of [...this.buffers.keys()].slice(0, -KEEP)) this.buffers.delete(old);
    return p;
  }

  /** Seconds between scheduling audio and it leaving the speakers. */
  get outputLatency() {
    return this.ctx.outputLatency || this.ctx.baseLatency || 0;
  }

  /** Starts the music and the original vocal together a moment from now, `offset` seconds into the song. Returns the
   * context time of song time 0.
   * @param {{ inst: AudioBuffer, vocals: AudioBuffer, guide: number, offset: number }} o */
  play({ inst, vocals, guide, offset }) {
    this.stop();
    const at = this.ctx.currentTime + 0.15;
    const sources = /** @type {const} */ ([[inst, 1], [vocals, guide]]).map(([buffer, gain]) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.master);
      src.start(at, offset);
      return src;
    });
    this.playing = { at: at - offset, pausedAt: null, sources };
    return this.playing.at;
  }

  /** Song time the listener hears right now (after output latency). */
  heardTime() {
    if (!this.playing) return 0;
    if (this.playing.pausedAt != null) return this.playing.pausedAt;
    return this.ctx.currentTime - this.playing.at - this.outputLatency;
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
    for (const src of this.playing.sources) {
      try { src.stop(); } catch {}
      src.disconnect();
    }
    this.playing = null;
  }
}
