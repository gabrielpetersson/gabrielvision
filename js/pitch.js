// @ts-check
// YIN pitch detector (de Cheveigné & Kawahara, 2002) on a 16 kHz-ish mono window.
// Shared by the AudioWorklet (live mic) and by offline tests, so both paths score identically.

// Below 70 Hz is bass guitar and room rumble, not a singing voice.
const MIN_HZ = 70;
const MAX_HZ = 1100;

export class Yin {
  /** @param {number} sampleRate */
  constructor(sampleRate, size = 1024, threshold = 0.2) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.threshold = threshold;
    this.minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
    this.maxTau = Math.min(Math.floor(size / 2), Math.ceil(sampleRate / MIN_HZ));
    this.d = new Float32Array(this.maxTau + 1);
  }

  // Returns { hz, clarity, rms }. hz is 0 when no periodic pitch was found.
  /** @param {Float32Array} buf */
  detect(buf) {
    const { d, minTau, maxTau } = this;
    const W = this.size - maxTau;
    let energy = 0;
    for (let i = 0; i < this.size; i++) energy += buf[i] * buf[i];
    const rms = Math.sqrt(energy / this.size);
    if (rms < 1e-4) return { hz: 0, clarity: 0, rms };

    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const diff = buf[i] - buf[i + tau];
        sum += diff * diff;
      }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }

    let tau = -1;
    for (let t = minTau; t <= maxTau; t++) {
      if (d[t] < this.threshold) {
        while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // No dip under the threshold: take the first dip about as deep as the deepest one. The deepest is often a
      // multiple of the true period (an octave low), especially when the song leaks into the mic.
      let best = minTau;
      for (let t = minTau + 1; t <= maxTau; t++) if (d[t] < d[best]) best = t;
      tau = best;
      for (let t = minTau + 1; t < maxTau; t++) if (d[t] <= d[t - 1] && d[t] <= d[t + 1] && d[t] <= d[best] + 0.05) { tau = t; break; }
    }
    // A dip at half or a third of the period nearly as deep as this one means this one is a subharmonic.
    for (const k of [2, 3]) {
      const h = Math.round(tau / k);
      if (h <= minTau + 2) continue;
      let m = h;
      for (let t = h - 2; t <= h + 2; t++) if (d[t] < d[m]) m = t;
      if (d[m] < d[tau] + 0.04) { tau = m; break; }
    }
    // A much deeper dip at three times this lag means we caught the voice's third harmonic. That reads as a fifth
    // off even after octaves fold, so it would cost points on a note sung dead on.
    if (tau * 3 + 2 <= maxTau) {
      let m = tau * 3;
      for (let t = m - 2; t <= tau * 3 + 2; t++) if (d[t] < d[m]) m = t;
      if (d[m] < d[tau] - 0.1) tau = m;
    }
    const clarity = 1 - d[tau];
    let better = tau;
    if (tau > minTau && tau < maxTau) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a + c - 2 * b;
      if (den !== 0) better = tau + (a - c) / (2 * den);
    }
    return { hz: this.sampleRate / better, clarity, rms };
  }
}

/** @param {number} hz */
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

