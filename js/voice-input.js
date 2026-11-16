// @ts-check
// A device's voice: the microphone (or, for the demo and tests, a recording played in sync) feeding the pitch worklet.
// Produces song-time pitch frames for scoring and the line on screen, a level for the mic meters, and recent PCM for
// the words check.
import { hzToMidi } from './pitch.js';

const CLARITY_MIN = 0.65;
// The same note an octave away has to hold this many frames (~130 ms) before the voice is believed to have jumped.
const OCTAVE_HOLD = 8;
const PCM_KEEP_SECONDS = 40;
const HISTORY = 400; // frames kept for the line's trail

// With headphones the mic hears only you, so it stays raw. Singing out loud through speakers, the browser's own echo
// cancellation takes out everything the computer plays ('all', not just call audio; browsers that only know on/off
// read it as on), the way FaceTime does. Noise suppression and gain control stay off: they flatten held notes.
/** @param {boolean} speakers */
export function openMic(speakers) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: /** @type {boolean} */ (/** @type {unknown} */ (speakers ? 'all' : false)),
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
}

export class VoiceInput {
  /** @param {import('./audio-engine.js').AudioEngine} engine @param {VoiceSource} source */
  constructor(engine, source) {
    this.engine = engine;
    this.source = source;
    /** Extra mic delay the player set, seconds. */
    this.latency = 0;
    /** @type {Frame[]} frames not yet drained */
    this.frames = [];
    /** @type {Frame[]} the last few seconds, for the trail */
    this.history = [];
    this.level = 0;
    /** @type {(number | null)[]} */
    this.recent = [];
    /** @type {number | null} */
    this.stable = null;
    this.octave = { dir: 0, n: 0 };
    this.floorDb = -70;
    /** @type {{ t0: number, rate: number, data: Float32Array }[]} */
    this.pcm = [];
    // A mic reports its own capture delay; a recording plays inside the context and has none.
    this.deviceLatency = source.kind === 'mic' ? /** @type {{ latency?: number }} */ (source.stream.getAudioTracks()[0]?.getSettings() ?? {}).latency || 0.01 : 0;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    /** @type {AudioNode | null} */
    this.input = null;
    // The song's clock, kept here so audio captured before the song stopped still maps to song time (the words check
    // on the last line runs after the music has stopped).
    /** @type {{ at: number, out: number } | null} */
    this.clock = null;
  }

  async connect() {
    const { ctx } = this.engine;
    await this.engine.workletReady;
    this.node = new AudioWorkletNode(ctx, 'pitch-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    if (this.source.kind === 'mic') {
      this.input = ctx.createMediaStreamSource(this.source.stream);
      this.input.connect(this.node);
    }
  }

  /** The song starts (or restarts after a jump): `at` is the context time of song time 0, maybe already past (a late
   * start). A recording starts playing from that point. @param {number} at */
  start(at) {
    this.clock = { at, out: this.engine.outputLatency };
    if (this.source.kind !== 'recording' || !this.node) return;
    const { ctx } = this.engine;
    this.stopRecording();
    const src = ctx.createBufferSource();
    src.buffer = this.source.buffer;
    src.connect(this.node);
    if (this.source.audible) src.connect(this.engine.master);
    const when = Math.max(at, ctx.currentTime);
    src.start(when, when - at);
    this.input = src;
  }

  /** @param {boolean} on */
  enablePcm(on) {
    this.node?.port.postMessage({ type: 'pcm', on });
  }

  /** Song time the singer was hearing when this context time was captured. @param {number} ctxTime */
  songTime(ctxTime) {
    const c = this.clock;
    if (!c) return ctxTime;
    if (this.source.kind === 'recording') return ctxTime - c.at;
    return ctxTime - this.deviceLatency - this.latency - c.at - c.out;
  }

  /** @param {{ type: 'pcm', t0: number, rate: number, data: Float32Array } | { type: 'pitch', frames: Float32Array }} msg */
  onMessage(msg) {
    if (msg.type === 'pcm') {
      this.pcm.push({ t0: msg.t0, rate: msg.rate, data: msg.data });
      const cutoff = msg.t0 - PCM_KEEP_SECONDS;
      while (this.pcm.length && this.pcm[0].t0 < cutoff) this.pcm.shift();
      return;
    }
    const f = msg.frames;
    for (let i = 0; i < f.length; i += 4) {
      const ct = f[i], hz = f[i + 1], clarity = f[i + 2], rms = f[i + 3];
      const db = 20 * Math.log10(rms + 1e-9);
      // Track the room's noise floor slowly upward, fast downward.
      this.floorDb = db < this.floorDb ? db : this.floorDb + 0.02;
      this.level = Math.max(0, Math.min(1, (db + 60) / 50));
      const loud = db > Math.max(-58, this.floorDb + 9);
      let midi = this.holdOctave(hz > 0 && clarity >= CLARITY_MIN && loud ? hzToMidi(hz) : null);
      // Median of three removes single-frame octave slips.
      this.recent.push(midi);
      if (this.recent.length > 3) this.recent.shift();
      if (midi != null && this.recent.length === 3 && this.recent.every((m) => m != null)) {
        midi = /** @type {number[]} */ ([...this.recent]).sort((a, b) => a - b)[1];
      }
      const frame = { t: this.songTime(ct), midi };
      this.frames.push(frame);
      this.history.push(frame);
    }
    const cut = this.history.length - HISTORY;
    if (cut > 0) this.history.splice(0, cut);
  }

  // Octave slips are short; real octave leaps last. Fold a reading onto the current note's octave until the new
  // octave has held for OCTAVE_HOLD frames.
  /** @param {number | null} midi */
  holdOctave(midi) {
    if (midi == null) {
      if (this.recent.every((m) => m == null)) this.stable = null;
      return null;
    }
    if (this.stable != null) {
      const dir = Math.round((midi - this.stable) / 12);
      if (dir !== 0 && Math.abs(midi - this.stable - 12 * dir) < 1.5) {
        this.octave = this.octave.dir === dir ? { dir, n: this.octave.n + 1 } : { dir, n: 1 };
        if (this.octave.n < OCTAVE_HOLD) midi -= 12 * dir;
        else this.octave = { dir: 0, n: 0 };
      } else this.octave = { dir: 0, n: 0 };
    }
    this.stable = this.stable == null || Math.abs(midi - this.stable) > 3 ? midi : this.stable * 0.7 + midi * 0.3;
    return midi;
  }

  drain() {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  /** Recorded voice between two song times, resampled to 16 kHz for the speech model. @param {number} t0 @param {number} t1 */
  audioBetween(t0, t1) {
    if (!this.pcm.length) return null;
    const chunks = this.pcm.map((c) => ({ ...c, s0: this.songTime(c.t0) }));
    const rate = chunks[0].rate;
    const n = Math.max(0, Math.round((t1 - t0) * 16000));
    const out = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / 16000;
      while (k + 1 < chunks.length && chunks[k + 1].s0 <= t) k++;
      const c = chunks[k];
      if (c.s0 > t) continue;
      const pos = (t - c.s0) * rate;
      const j = Math.floor(pos);
      if (j + 1 >= c.data.length) continue;
      out[i] = c.data[j] + (c.data[j + 1] - c.data[j]) * (pos - j);
    }
    return out;
  }

  stopRecording() {
    if (!(this.input instanceof AudioBufferSourceNode)) return;
    try { this.input.stop(); } catch {}
    this.input.disconnect();
    this.input = null;
  }

  disconnect() {
    this.stopRecording();
    this.input?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
  }
}
