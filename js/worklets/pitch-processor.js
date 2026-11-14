// Runs on the audio thread: low-pass + decimate the mic to ~16 kHz, run YIN every 256 samples,
// and post pitch frames (stamped in AudioContext time) plus raw 16 kHz-ish PCM for the lyric check.
import { Yin } from '../pitch.js';

const SIZE = 1024;
const HOP = 256;
const PCM_CHUNK = 4096;

// RBJ low-pass biquad, used twice in series as the decimation filter.
class Biquad {
  constructor(sr, fc, q) {
    const w = (2 * Math.PI * fc) / sr, c = Math.cos(w), a = Math.sin(w) / (2 * q), n = 1 + a;
    this.b0 = (1 - c) / 2 / n; this.b1 = (1 - c) / n; this.b2 = this.b0;
    this.a1 = (-2 * c) / n; this.a2 = (1 - a) / n;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.factor = Math.max(1, Math.round(sampleRate / 16000));
    this.rate = sampleRate / this.factor;
    const fc = this.rate * 0.42;
    this.lp = [new Biquad(sampleRate, fc, 0.541), new Biquad(sampleRate, fc, 1.307)];
    this.yin = new Yin(this.rate, SIZE);
    this.ring = new Float32Array(SIZE);
    this.win = new Float32Array(SIZE);
    this.w = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.phase = 0;
    this.frames = [];
    this.pcmOn = false;
    this.pcm = new Float32Array(PCM_CHUNK);
    this.pcmLen = 0;
    this.pcmT0 = 0;
    this.port.onmessage = (e) => { if (e.data?.type === 'pcm') this.pcmOn = !!e.data.on; };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0], ch1 = input[1];
    const [f1, f2] = this.lp;
    for (let i = 0; i < ch0.length; i++) {
      const x = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      const y = f2.run(f1.run(x));
      if (++this.phase < this.factor) continue;
      this.phase = 0;
      const absTime = (currentFrame + i) / sampleRate;
      this.ring[this.w] = y;
      this.w = (this.w + 1) % SIZE;
      if (this.filled < SIZE) this.filled++;
      if (this.pcmOn) {
        if (this.pcmLen === 0) this.pcmT0 = absTime;
        this.pcm[this.pcmLen++] = y;
        if (this.pcmLen === PCM_CHUNK) {
          this.port.postMessage({ type: 'pcm', t0: this.pcmT0, rate: this.rate, data: this.pcm }, [this.pcm.buffer]);
          this.pcm = new Float32Array(PCM_CHUNK);
          this.pcmLen = 0;
        }
      }
      if (++this.sinceHop >= HOP && this.filled === SIZE) {
        this.sinceHop = 0;
        // Unroll the circular buffer so the window is oldest-to-newest.
        this.win.set(this.ring.subarray(this.w), 0);
        this.win.set(this.ring.subarray(0, this.w), SIZE - this.w);
        const r = this.yin.detect(this.win);
        this.frames.push(absTime - SIZE / 2 / this.rate, r.hz, r.clarity, r.rms);
      }
    }
    if (this.frames.length) {
      this.port.postMessage({ type: 'pitch', frames: this.frames });
      this.frames = [];
    }
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
