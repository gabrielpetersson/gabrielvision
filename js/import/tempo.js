// Tempo and beat phase of the backing track, for the beat grid and the stage pulse.
// Spectral-flux onsets, autocorrelation with a soft preference around 115 BPM, then the best beat offset.

import { FFT } from './fft.js';

export function estimateTempo(audio, rate) {
  const n = 1024, hop = 256;
  const fft = new FFT(n);
  const frames = Math.floor((audio.length - n) / hop);
  if (frames < 50) return { bpm: 120, offset: 0 };
  const re = new Float64Array(n), im = new Float64Array(n), R = new Float64Array(n), I = new Float64Array(n);
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const bins = n / 2;
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    for (let j = 0; j < n; j++) { re[j] = audio[t * hop + j] * win[j]; im[j] = 0; }
    fft.forward(re, im, R, I);
    let f = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(R[k], I[k]));
      f += Math.max(0, cur[k] - prev[k]);
    }
    flux[t] = f;
    [prev, cur] = [cur, prev];
  }
  // Remove the slow trend so loud sections don't dominate.
  const onset = new Float64Array(frames);
  const half = Math.round((0.5 * rate) / hop);
  let sum = 0;
  for (let t = 0; t < Math.min(frames, half); t++) sum += flux[t];
  for (let t = 0; t < frames; t++) {
    if (t + half < frames) sum += flux[t + half];
    if (t - half - 1 >= 0) sum -= flux[t - half - 1];
    const count = Math.min(frames, t + half + 1) - Math.max(0, t - half);
    onset[t] = Math.max(0, flux[t] - sum / count);
  }
  const fps = rate / hop;
  const lagFor = (bpm) => (60 * fps) / bpm;
  const ac = (lag) => {
    const l0 = Math.floor(lag), a = lag - l0;
    let s = 0;
    for (let t = 0; t + l0 + 1 < frames; t++) s += onset[t] * (onset[t + l0] * (1 - a) + onset[t + l0 + 1] * a);
    return s;
  };
  let best = 120, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.9) ** 2);
    // Reward periodicity at the beat and at two beats, so off-beat patterns don't win.
    const score = (ac(lagFor(bpm)) + 0.5 * ac(lagFor(bpm / 2))) * prior;
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  const period = lagFor(best);
  let offset = 0, phaseScore = -Infinity;
  for (let p = 0; p < period; p += 0.5) {
    let s = 0;
    for (let x = p; x < frames - 1; x += period) {
      const i = Math.floor(x), a = x - i;
      s += onset[i] * (1 - a) + onset[i + 1] * a;
    }
    if (s > phaseScore) { phaseScore = s; offset = p; }
  }
  // Onset frames are stamped at the window start; the onset sits near its centre.
  return { bpm: Math.round(best * 10) / 10, offset: (offset * hop + n / 2) / rate };
}
