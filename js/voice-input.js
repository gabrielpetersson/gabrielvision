// One singer's voice: a microphone (or, for the demo singer and tests, an audio buffer played in sync)
// feeding the pitch worklet. Produces song-time pitch frames for scoring and the comet trail.
import { hzToMidi } from './pitch.js';

const CLARITY_MIN = 0.65;
// The same note an octave away has to hold this many frames (~130 ms) before the voice is believed to have jumped.
const OCTAVE_HOLD = 8;
const PCM_KEEP_SECONDS = 40;

export async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

// With headphones the mic hears only you, so it stays raw. Singing out loud through speakers, the browser's own echo
// cancellation takes out everything the computer plays ('all', not just call audio; browsers that only know on/off
// read it as on), the way FaceTime does. Noise suppression and gain control stay off: they flatten held notes.
export async function openMic(deviceId, speakers) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: speakers ? 'all' : false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
}

export class VoiceInput {
  // source: { stream } for a microphone, or { buffer, audible } for an in-sync recording.
  constructor(engine, source, { latency = 0 } = {}) {
    this.engine = engine;
    this.source = source;
    this.internal = !!source.buffer;
    this.latency = latency;
    this.frames = [];
    this.history = [];
    this.level = 0;
    this.lastMidi = null;
    this.recent = [];
    this.stable = null;
    this.octave = { dir: 0, n: 0 };
    this.floorDb = -70;
    this.pcm = [];
    this.pcmOn = false;
  }

  async connect() {
    const { ctx } = this.engine;
    await this.engine.workletReady;
    this.node = new AudioWorkletNode(ctx, 'pitch-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    if (this.source.stream) {
      this.input = ctx.createMediaStreamSource(this.source.stream);
      this.input.connect(this.node);
      const track = this.source.stream.getAudioTracks()[0];
      this.deviceLatency = track?.getSettings?.().latency || 0.01;
    }
  }

  // For buffer sources: start exactly when the song starts so the singer is in sync.
  startWithSong(at, offset = 0) {
    if (!this.source.buffer) return;
    const { ctx } = this.engine;
    const src = ctx.createBufferSource();
    src.buffer = this.source.buffer;
    src.connect(this.node);
    if (this.source.audible) src.connect(this.engine.master);
    src.start(at + offset > ctx.currentTime ? at + offset : ctx.currentTime, Math.max(0, offset));
    this.input = src;
  }

  enablePcm(on) {
    this.pcmOn = on;
    this.node?.port.postMessage({ type: 'pcm', on });
  }

  songTime(ctxTime) {
    const p = this.engine.playing;
    if (!p) return ctxTime;
    if (this.internal) return ctxTime - p.at;
    return this.engine.songTimeOf(ctxTime, this.deviceLatency + this.latency);
  }

  onMessage(msg) {
    if (msg.type === 'pcm') {
      this.pcm.push({ t0: msg.t0, rate: msg.rate, data: msg.data });
      const cutoff = msg.t0 - PCM_KEEP_SECONDS;
      while (this.pcm.length && this.pcm[0].t0 < cutoff) this.pcm.shift();
      return;
    }
    const f = msg.frames;
    for (let i = 0; i < f.length; i += 4) {
      const [ct, hz, clarity, rms] = [f[i], f[i + 1], f[i + 2], f[i + 3]];
      const db = 20 * Math.log10(rms + 1e-9);
      // Track the room's noise floor slowly upward, fast downward.
      this.floorDb = db < this.floorDb ? db : this.floorDb + 0.02;
      this.level = Math.max(0, Math.min(1, (db + 60) / 50));
      const loud = db > Math.max(-58, this.floorDb + 9);
      let midi = hz > 0 && clarity >= CLARITY_MIN && loud ? hzToMidi(hz) : null;
      midi = this.holdOctave(midi);
      // Median of three removes single-frame octave slips.
      this.recent.push(midi);
      if (this.recent.length > 3) this.recent.shift();
      if (midi != null && this.recent.length === 3 && this.recent.every((m) => m != null)) {
        midi = [...this.recent].sort((a, b) => a - b)[1];
      }
      const t = this.songTime(ct);
      const frame = { t, midi, level: this.level };
      this.frames.push(frame);
      this.history.push(frame);
      if (midi != null) this.lastMidi = midi;
    }
    const cut = this.history.length - 400;
    if (cut > 0) this.history.splice(0, cut);
  }

  // Octave slips are short; real octave leaps last. Fold a reading onto the current note's octave until the new
  // octave has held for OCTAVE_HOLD frames.
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

  // Recorded voice between two song times, resampled to 16 kHz for the speech model.
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

  reset() {
    this.frames = [];
    this.history = [];
    this.recent = [];
    this.stable = null;
    this.octave = { dir: 0, n: 0 };
    this.pcm = [];
  }

  disconnect() {
    try { this.input?.stop?.(); } catch {}
    this.input?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
  }
}
