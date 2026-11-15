// MP3 encoder for songs passed between friends (lamejs). A classic worker so it can load the encoder script.
importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');

const BLOCK = 1152;
const int16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const x = Math.max(-1, Math.min(1, f[i]));
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return out;
};

// channels: Float32Arrays (1 or 2) at `rate`; skip: samples dropped from the start (see share.js ENCODER_DELAY).
onmessage = (e) => {
  const { channels, rate, kbps, skip } = e.data;
  try {
    const pcm = channels.map((c) => int16(c.subarray(skip)));
    const enc = new lamejs.Mp3Encoder(pcm.length, rate, kbps);
    const parts = [];
    const n = pcm[0].length;
    for (let i = 0; i < n; i += BLOCK) {
      const l = pcm[0].subarray(i, i + BLOCK);
      const chunk = pcm.length > 1 ? enc.encodeBuffer(l, pcm[1].subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
      if (chunk.length) parts.push(new Uint8Array(chunk));
      if (i % (BLOCK * 400) === 0) postMessage({ type: 'progress', value: i / n });
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    postMessage({ type: 'done', blob });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
