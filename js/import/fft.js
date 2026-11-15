// Complex FFT for lengths built from factors 2, 3, 4 and 5 (a port of KISS FFT's mixed-radix recursion).
// The vocal model works on 7680-point spectra (2^9 · 3 · 5), so a power-of-two FFT is not enough.

export class FFT {
  constructor(n) {
    this.n = n;
    this.twr = new Float64Array(n);
    this.twi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.twr[i] = Math.cos(a);
      this.twi[i] = Math.sin(a);
    }
    this.factors = [];
    let p = 4, m = n;
    const root = Math.floor(Math.sqrt(n));
    while (m > 1) {
      while (m % p) {
        p = p === 4 ? 2 : p === 2 ? 3 : p + 2;
        if (p > root) p = m;
      }
      m /= p;
      if (p > 5) throw new Error(`FFT length ${n} has an unsupported factor ${p}`);
      this.factors.push(p, m);
    }
  }

  // out = DFT(in), with e^{-2πi kn/N}. Inputs and outputs are separate re/im arrays.
  forward(inRe, inIm, outRe, outIm) {
    this.work(outRe, outIm, 0, inRe, inIm, 0, 1, 0);
  }

  work(oR, oI, o, iR, iI, f, fstride, fi) {
    const p = this.factors[fi], m = this.factors[fi + 1];
    const end = o + p * m;
    if (m === 1) {
      for (let k = o; k < end; k++, f += fstride) { oR[k] = iR[f]; oI[k] = iI[f]; }
    } else {
      for (let k = o; k < end; k += m, f += fstride) this.work(oR, oI, k, iR, iI, f, fstride * p, fi + 2);
    }
    if (p === 2) this.bfly2(oR, oI, o, fstride, m);
    else if (p === 3) this.bfly3(oR, oI, o, fstride, m);
    else if (p === 4) this.bfly4(oR, oI, o, fstride, m);
    else this.bfly5(oR, oI, o, fstride, m);
  }

  bfly2(R, I, o, fs, m) {
    const { twr, twi } = this;
    for (let u = 0; u < m; u++) {
      const a = o + u, b = a + m, w = u * fs;
      const tr = R[b] * twr[w] - I[b] * twi[w], ti = R[b] * twi[w] + I[b] * twr[w];
      R[b] = R[a] - tr; I[b] = I[a] - ti;
      R[a] += tr; I[a] += ti;
    }
  }

  bfly3(R, I, o, fs, m) {
    const { twr, twi } = this;
    const e = twi[fs * m];
    for (let u = 0; u < m; u++) {
      const a = o + u, b = a + m, c = b + m, w1 = u * fs, w2 = 2 * u * fs;
      const s1r = R[b] * twr[w1] - I[b] * twi[w1], s1i = R[b] * twi[w1] + I[b] * twr[w1];
      const s2r = R[c] * twr[w2] - I[c] * twi[w2], s2i = R[c] * twi[w2] + I[c] * twr[w2];
      const s3r = s1r + s2r, s3i = s1i + s2i;
      const s0r = (s1r - s2r) * e, s0i = (s1i - s2i) * e;
      const br = R[a] - s3r * 0.5, bi = I[a] - s3i * 0.5;
      R[a] += s3r; I[a] += s3i;
      R[c] = br + s0i; I[c] = bi - s0r;
      R[b] = br - s0i; I[b] = bi + s0r;
    }
  }

  bfly4(R, I, o, fs, m) {
    const { twr, twi } = this;
    for (let u = 0; u < m; u++) {
      const a = o + u, b = a + m, c = b + m, d = c + m;
      const w1 = u * fs, w2 = 2 * w1, w3 = 3 * w1;
      const s0r = R[b] * twr[w1] - I[b] * twi[w1], s0i = R[b] * twi[w1] + I[b] * twr[w1];
      const s1r = R[c] * twr[w2] - I[c] * twi[w2], s1i = R[c] * twi[w2] + I[c] * twr[w2];
      const s2r = R[d] * twr[w3] - I[d] * twi[w3], s2i = R[d] * twi[w3] + I[d] * twr[w3];
      const s5r = R[a] - s1r, s5i = I[a] - s1i;
      const ar = R[a] + s1r, ai = I[a] + s1i;
      const s3r = s0r + s2r, s3i = s0i + s2i;
      const s4r = s0r - s2r, s4i = s0i - s2i;
      R[c] = ar - s3r; I[c] = ai - s3i;
      R[a] = ar + s3r; I[a] = ai + s3i;
      R[b] = s5r + s4i; I[b] = s5i - s4r;
      R[d] = s5r - s4i; I[d] = s5i + s4r;
    }
  }

  bfly5(R, I, o, fs, m) {
    const { twr, twi } = this;
    const yar = twr[fs * m], yai = twi[fs * m], ybr = twr[2 * fs * m], ybi = twi[2 * fs * m];
    for (let u = 0; u < m; u++) {
      const i0 = o + u, i1 = i0 + m, i2 = i1 + m, i3 = i2 + m, i4 = i3 + m;
      const w1 = u * fs, w2 = 2 * w1, w3 = 3 * w1, w4 = 4 * w1;
      const s0r = R[i0], s0i = I[i0];
      const s1r = R[i1] * twr[w1] - I[i1] * twi[w1], s1i = R[i1] * twi[w1] + I[i1] * twr[w1];
      const s2r = R[i2] * twr[w2] - I[i2] * twi[w2], s2i = R[i2] * twi[w2] + I[i2] * twr[w2];
      const s3r = R[i3] * twr[w3] - I[i3] * twi[w3], s3i = R[i3] * twi[w3] + I[i3] * twr[w3];
      const s4r = R[i4] * twr[w4] - I[i4] * twi[w4], s4i = R[i4] * twi[w4] + I[i4] * twr[w4];
      const s7r = s1r + s4r, s7i = s1i + s4i, s10r = s1r - s4r, s10i = s1i - s4i;
      const s8r = s2r + s3r, s8i = s2i + s3i, s9r = s2r - s3r, s9i = s2i - s3i;
      R[i0] = s0r + s7r + s8r; I[i0] = s0i + s7i + s8i;
      const s5r = s0r + s7r * yar + s8r * ybr, s5i = s0i + s7i * yar + s8i * ybr;
      const s6r = s10i * yai + s9i * ybi, s6i = -(s10r * yai) - s9r * ybi;
      R[i1] = s5r - s6r; I[i1] = s5i - s6i;
      R[i4] = s5r + s6r; I[i4] = s5i + s6i;
      const s11r = s0r + s7r * ybr + s8r * yar, s11i = s0i + s7i * ybr + s8i * yar;
      const s12r = -(s10i * ybi) + s9i * yai, s12i = s10r * ybi - s9r * yai;
      R[i2] = s11r + s12r; I[i2] = s11i + s12i;
      R[i3] = s11r - s12r; I[i3] = s11i - s12i;
    }
  }
}
