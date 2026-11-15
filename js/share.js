// Packing a stored song into one file to pass to friends in a room, and unpacking one received.
// File: "GVS1", a 4-byte header length, a JSON header (song details and part sizes), then the parts' bytes.
// The two tracks go as MP3 (a WAV pair is 50+ MB; this is about a tenth of that).

const MAGIC = 'GVS1';
// lamejs output decodes this many samples late (encoder + decoder delay, measured in Chrome with
// devweb/tests/mp3-delay.html); dropping them before encoding keeps the notes on the music.
const ENCODER_DELAY = 1105;

function encode(channels, rate, kbps, onProgress) {
  const w = new Worker(new URL('./workers/mp3-worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') return onProgress(m.value);
      w.terminate();
      m.type === 'done' ? resolve(m.blob) : reject(new Error(m.message));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Could not compress the song')); };
    w.postMessage({ channels, rate, kbps, skip: ENCODER_DELAY });
  });
}

// A track as MP3: songs received from friends already are; uploads are stored as WAV and get compressed.
async function asMp3(blob, kbps, onProgress) {
  if (blob.type === 'audio/mpeg') return blob;
  const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return encode(channels, buf.sampleRate, kbps, onProgress);
}

export async function packSong(rec, onProgress) {
  const inst = await asMp3(rec.inst, 160, (p) => onProgress(p * 0.7));
  const vocals = await asMp3(rec.vocals, 80, (p) => onProgress(0.7 + p * 0.3));
  const parts = { inst, vocals, cover: rec.cover, stage: rec.stage };
  const header = {
    id: rec.id, title: rec.title, artist: rec.artist, createdAt: rec.createdAt, accents: rec.accents, chart: rec.chart,
    parts: Object.entries(parts).map(([name, b]) => ({ name, type: b.type, size: b.size })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(4, json.length);
  onProgress(1);
  return new Blob([head, json, ...Object.values(parts)], { type: 'application/octet-stream' });
}

// A received song is someone else's file and its details end up in this page, so it is checked before it is kept:
// the id must be the one asked for, the colours real colours, and the parts MP3s and pictures.
const PART_TYPES = { inst: /^audio\/mpeg$/, vocals: /^audio\/mpeg$/, cover: /^image\/(png|jpe?g|webp|gif)$/i, stage: /^image\/(png|jpe?g|webp|gif)$/i };
const COLOUR = /^#[0-9a-f]{6}$/i;

// from: who sent it, kept so the library can say where a song came from. id: the song asked for.
export async function unpackSong(blob, from, id) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('That song file is damaged.');
  const len = new DataView(bytes.buffer).getUint32(4);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  const ok = header.id === id && /^[a-z0-9-]{1,40}$/.test(id) && header.chart && typeof header.chart === 'object'
    && Array.isArray(header.accents) && header.accents.length === 2 && header.accents.every((c) => COLOUR.test(c))
    && Array.isArray(header.parts) && header.parts.length === 4 && header.parts.every((p) => PART_TYPES[p.name]?.test(p.type) && p.size >= 0)
    && new Set(header.parts.map((p) => p.name)).size === 4 && /^([a-z]{2,3}(-[a-z0-9]{2,8})*)?$/i.test(header.chart.language || '');
  if (!ok) throw new Error('That song file is damaged.');
  let o = 8 + len;
  const part = {};
  for (const p of header.parts) {
    part[p.name] = new Blob([bytes.subarray(o, o + p.size)], { type: p.type });
    o += p.size;
  }
  return { id, title: String(header.title || 'Song'), artist: String(header.artist || ''), createdAt: +header.createdAt || Date.now(), accents: header.accents, chart: header.chart, where: 'friend', from, ...part };
}
