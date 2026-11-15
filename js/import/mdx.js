// MDX-Net vocal separation around an injected model runner (ONNX Runtime in the browser, onnxruntime in tests).
// Mirrors UVR / python-audio-separator: complex STFT (7680 / 1024, first 3072 bins) in, vocal spectrum out,
// chunks of 256 frames blended with a Hann window at 25% overlap.

import { FFT } from './fft.js';

export const MDX = { rate: 44100, nFft: 7680, hop: 1024, dimF: 3072, dimT: 256 };

export class MdxSeparator {
  // run(input: Float32Array of shape [1, 4, dimF, dimT]) resolves to the model output of the same shape.
  constructor(run) {
    this.run = run;
    const { nFft, hop, dimT } = MDX;
    this.fft = new FFT(nFft);
    this.window = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
    this.chunk = hop * (dimT - 1);
    this.trim = nFft / 2;
    this.gen = this.chunk - 2 * this.trim;
    this.step = Math.floor(0.75 * this.chunk);
    const n = nFft;
    this.zr = new Float64Array(n); this.zi = new Float64Array(n);
    this.Zr = new Float64Array(n); this.Zi = new Float64Array(n);
  }

  chunkCount(length) {
    const total = this.trim + length + this.gen + this.trim - (length % this.gen);
    return Math.ceil(total / this.step);
  }

  // left/right: Float32Array at 44.1 kHz. Resolves to the vocal stem { left, right }.
  async separate(left, right, onProgress = () => {}) {
    const len = left.length;
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    const gain = peak > 0.9 ? 0.9 / peak : 1;
    const pad = this.gen + this.trim - (len % this.gen);
    const total = this.trim + len + pad;
    const mixL = new Float32Array(total), mixR = new Float32Array(total);
    for (let i = 0; i < len; i++) { mixL[this.trim + i] = left[i] * gain; mixR[this.trim + i] = right[i] * gain; }
    const resL = new Float32Array(total), resR = new Float32Array(total), div = new Float32Array(total);
    const count = Math.ceil(total / this.step);
    let done = 0;
    for (let start = 0; start < total; start += this.step) {
      const end = Math.min(start + this.chunk, total);
      const actual = end - start;
      const partL = new Float32Array(this.chunk), partR = new Float32Array(this.chunk);
      partL.set(mixL.subarray(start, end));
      partR.set(mixR.subarray(start, end));
      const spec = this.stft(partL, partR);
      const out = await this.run(spec);
      const [vl, vr] = this.istft(out);
      for (let i = 0; i < actual; i++) {
        // np.hanning: symmetric window over the part that exists.
        const w = actual > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (actual - 1)) : 1;
        resL[start + i] += vl[i] * w;
        resR[start + i] += vr[i] * w;
        div[start + i] += w;
      }
      onProgress(++done / count);
    }
    const outL = new Float32Array(len), outR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const d = div[this.trim + i];
      if (d > 1e-6) {
        outL[i] = resL[this.trim + i] / d / gain;
        outR[i] = resR[this.trim + i] / d / gain;
      }
    }
    return { left: outL, right: outR };
  }

  // Two real channels packed into one complex FFT per frame; reflect padding like torch.stft(center=True).
  stft(l, r) {
    const { nFft: n, hop, dimF, dimT } = MDX;
    const half = n / 2, L = l.length;
    const out = new Float32Array(4 * dimF * dimT);
    const plane = dimF * dimT;
    const { zr, zi, Zr, Zi, window } = this;
    for (let t = 0; t < dimT; t++) {
      const s = t * hop - half;
      for (let j = 0; j < n; j++) {
        let k = s + j;
        if (k < 0) k = -k;
        else if (k >= L) k = 2 * (L - 1) - k;
        zr[j] = l[k] * window[j];
        zi[j] = r[k] * window[j];
      }
      this.fft.forward(zr, zi, Zr, Zi);
      // The model ignores the lowest three bins (UVR zeroes them before inference).
      for (let f = 3; f < dimF; f++) {
        const g = (n - f) % n;
        const ar = Zr[f], ai = Zi[f], br = Zr[g], bi = -Zi[g];
        const o = f * dimT + t;
        out[o] = (ar + br) / 2;
        out[plane + o] = (ai + bi) / 2;
        out[2 * plane + o] = (ai - bi) / 2;
        out[3 * plane + o] = -(ar - br) / 2;
      }
    }
    return out;
  }

  // Inverse of stft for a model output; returns [left, right] of length chunk.
  istft(spec) {
    const { nFft: n, hop, dimF, dimT } = MDX;
    const half = n / 2, plane = dimF * dimT;
    const olaL = new Float64Array(this.chunk + n), olaR = new Float64Array(this.chunk + n), env = new Float64Array(this.chunk + n);
    const { zr, zi, Zr, Zi, window } = this;
    for (let t = 0; t < dimT; t++) {
      zr.fill(0);
      zi.fill(0);
      for (let f = 0; f < dimF; f++) {
        const o = f * dimT + t;
        const lr = spec[o], li = f === 0 ? 0 : spec[plane + o];
        const rr = spec[2 * plane + o], ri = f === 0 ? 0 : spec[3 * plane + o];
        // Z = L + iR; inverse via conj(FFT(conj(Z))) / n.
        zr[f] = lr - ri;
        zi[f] = -(li + rr);
        if (f > 0) {
          const g = n - f;
          // Hermitian halves: L[n-f] = conj(L[f]), R[n-f] = conj(R[f]).
          zr[g] = lr + ri;
          zi[g] = -(-li + rr);
        }
      }
      this.fft.forward(zr, zi, Zr, Zi);
      const s = t * hop;
      for (let j = 0; j < n; j++) {
        const w = window[j];
        olaL[s + j] += (Zr[j] / n) * w;
        olaR[s + j] += (-Zi[j] / n) * w;
        env[s + j] += w * w;
      }
    }
    const left = new Float32Array(this.chunk), right = new Float32Array(this.chunk);
    for (let i = 0; i < this.chunk; i++) {
      const e = env[i + half];
      if (e > 1e-11) { left[i] = olaL[i + half] / e; right[i] = olaR[i + half] / e; }
    }
    return [left, right];
  }
}
