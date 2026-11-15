// FCPE pitch for uploaded songs (torchfcpe, MIT): a log-mel spectrogram goes through a small network that scores 360
// pitch bins per 10 ms frame. This module is the part around the network, so the browser worker and Node tests share it:
// the mel front end (torchfcpe's STFT and librosa's Slaney mel filters) and the local-argmax decoder.

import { FFT } from './fft.js';

export const FCPE = { rate: 16000, nFft: 1024, hop: 160, mels: 128, bins: 360, f0Min: 32.7, f0Max: 1975.5, threshold: 0.006 };

const hzToMel = (f) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
const melToHz = (m) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) * (m - 15)) / 27));

// librosa.filters.mel(sr=16000, n_fft=1024, n_mels=128, fmin=0, fmax=8000): triangles on the Slaney scale, area-normalised.
function melFilters() {
  const { rate, nFft, mels } = FCPE;
  const bins = nFft / 2 + 1;
  const pts = Array.from({ length: mels + 2 }, (_, i) => melToHz((hzToMel(rate / 2) * i) / (mels + 1)));
  const out = Array.from({ length: mels }, () => new Float32Array(bins));
  for (let m = 0; m < mels; m++) {
    const [a, b, c] = [pts[m], pts[m + 1], pts[m + 2]];
    const norm = 2 / (c - a);
    for (let k = 0; k < bins; k++) {
      const f = (k * rate) / nFft;
      out[m][k] = Math.max(0, Math.min((f - a) / (b - a), (c - f) / (c - b))) * norm;
    }
  }
  return out;
}

// Log-mel frames for 16 kHz mono audio, frames x 128 (row-major), one frame per 160 samples plus one, like torchfcpe.
export function logMel(audio) {
  const { nFft, hop, mels } = FCPE;
  const pad = (nFft - hop) / 2;
  const n = audio.length;
  const at = (i) => audio[i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i]; // reflect padding
  const frames = Math.floor(n / hop) + 1;
  const filters = melFilters();
  const fft = new FFT(nFft);
  const win = Float64Array.from({ length: nFft }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft));
  const re = new Float64Array(nFft), im = new Float64Array(nFft), oR = new Float64Array(nFft), oI = new Float64Array(nFft);
  const mag = new Float64Array(nFft / 2 + 1);
  const out = new Float32Array(frames * mels);
  // torch.stft without centering yields one frame fewer than torchfcpe asks for; it repeats the last one.
  const stftFrames = Math.floor((n + 2 * pad - nFft) / hop) + 1;
  for (let t = 0; t < frames; t++) {
    const s = Math.min(t, stftFrames - 1) * hop - pad;
    for (let i = 0; i < nFft; i++) { re[i] = at(s + i) * win[i]; im[i] = 0; }
    fft.forward(re, im, oR, oI);
    for (let k = 0; k < mag.length; k++) mag[k] = Math.sqrt(oR[k] * oR[k] + oI[k] * oI[k] + 1e-9);
    for (let m = 0; m < mels; m++) {
      const w = filters[m];
      let v = 0;
      for (let k = 0; k < mag.length; k++) if (w[k]) v += w[k] * mag[k];
      out[t * mels + m] = Math.log(Math.max(v, 1e-5));
    }
  }
  return { data: out, frames };
}

// Network output (frames x 360 scores) to Hz per frame: weighted mean of the 9 bins around the best one, 0 when unsure.
export function decodeF0(latent, frames) {
  const { bins, f0Min, f0Max, threshold } = FCPE;
  const lo = 1200 * Math.log2(f0Min / 10), hi = 1200 * Math.log2(f0Max / 10);
  const cents = Float64Array.from({ length: bins }, (_, i) => lo + ((hi - lo) * i) / (bins - 1));
  const hz = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const row = t * bins;
    let best = 0;
    for (let i = 1; i < bins; i++) if (latent[row + i] > latent[row + best]) best = i;
    if (latent[row + best] <= threshold) continue;
    let num = 0, den = 0;
    for (let i = best - 4; i <= best + 4; i++) {
      const j = Math.min(bins - 1, Math.max(0, i));
      num += cents[j] * latent[row + j];
      den += latent[row + j];
    }
    hz[t] = 10 * 2 ** (num / den / 1200);
  }
  return hz;
}
