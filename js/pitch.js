// YIN pitch detector (de Cheveigné & Kawahara, 2002) on a 16 kHz-ish mono window.
// Shared by the AudioWorklet (live mic) and by offline tests, so both paths score identically.

export const MIN_HZ = 60;
export const MAX_HZ = 1100;

export class Yin {
  constructor(sampleRate, size = 1024, threshold = 0.15) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.threshold = threshold;
    this.minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
    this.maxTau = Math.min(Math.floor(size / 2), Math.ceil(sampleRate / MIN_HZ));
    this.d = new Float32Array(this.maxTau + 1);
  }

  // Returns { hz, clarity, rms }. hz is 0 when no periodic pitch was found.
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
      // No dip under the threshold: take the global minimum but report low clarity.
      let best = minTau;
      for (let t = minTau + 1; t <= maxTau; t++) if (d[t] < d[best]) best = t;
      tau = best;
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

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const midiName = (m) => {
  const r = Math.round(m);
  return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
};
