// @ts-check
// Packing a stored song into one file to pass to friends in a room, and unpacking one received.
// File: "GVS2", a 4-byte header length, a JSON header (song details and part sizes), then the parts' bytes.
// The two tracks go as MP3 (a WAV pair is 50+ MB; this is about a tenth of that).

const MAGIC = 'GVS2';
// lamejs output decodes this many samples late (encoder + decoder delay, measured in Chrome with
// devweb/tests/mp3-delay.html); dropping them before encoding keeps the notes on the music.
const ENCODER_DELAY = 1105;

/** @param {Float32Array[]} channels @param {number} rate @param {number} kbps @param {(p: number) => void} onProgress
 * @returns {Promise<Blob>} */
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

/** A track as MP3: songs received from friends already are; uploads are stored as WAV and get compressed.
 * @param {Blob} blob @param {number} kbps @param {(p: number) => void} onProgress */
async function asMp3(blob, kbps, onProgress) {
  if (blob.type === 'audio/mpeg') return blob;
  const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return encode(channels, buf.sampleRate, kbps, onProgress);
}

/** @param {SongRecord} rec @param {(p: number) => void} onProgress */
export async function packSong(rec, onProgress) {
  const inst = await asMp3(rec.inst, 160, (p) => onProgress(p * 0.7));
  const vocals = await asMp3(rec.vocals, 80, (p) => onProgress(0.7 + p * 0.3));
  const parts = { inst, vocals, cover: rec.cover };
  const header = {
    id: rec.id, title: rec.title, artist: rec.artist, accents: rec.accents, chart: rec.chart,
    parts: Object.entries(parts).map(([name, b]) => ({ name, type: b.type, size: b.size })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(4, json.length);
  onProgress(1);
  return new Blob([head, json, ...Object.values(parts)], { type: 'application/octet-stream' });
}

// A received song is someone else's file and its details end up in this page, so everything in it is checked and
// copied field by field before it is kept: the id must be the one asked for, colours real colours, the parts MP3s and
// pictures, and the chart plain numbers and short strings.
const PART_TYPES = { inst: /^audio\/mpeg$/, vocals: /^audio\/mpeg$/, cover: /^image\/(png|jpe?g|webp|gif)$/i };
const COLOUR = /^#[0-9a-f]{6}$/i;
const damaged = () => new Error('That song file is damaged.');
/** @param {unknown} v @param {number} lo @param {number} hi */
const num = (v, lo, hi) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw damaged();
  return v;
};
/** @param {unknown} v @param {number} max */
const str = (v, max) => {
  if (typeof v !== 'string' || v.length > max) throw damaged();
  return v;
};
/** @param {unknown} v @param {number} max @returns {any[]} */
const arr = (v, max) => {
  if (!Array.isArray(v) || v.length > max) throw damaged();
  return v;
};

/** @param {any} c @returns {Chart} */
function cleanChart(c) {
  if (!c || typeof c !== 'object') throw damaged();
  const duration = num(c.duration, 10, 3600);
  const language = c.language == null ? null : str(c.language, 16);
  if (language != null && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(language)) throw damaged();
  const lines = arr(c.lines, 2000).map((l) => ({
    start: num(l?.start, 0, duration), end: num(l?.end, 0, duration + 5), text: str(l?.text, 400),
    notes: arr(l?.notes, 300).map((n) => ({
      t: num(n?.t, 0, duration), d: num(n?.d, 0.001, 30), p: num(n?.p, 0, 127), syl: str(n?.syl, 60), wordEnd: !!n?.wordEnd, golden: !!n?.golden,
    })),
  }));
  if (!lines.length || lines.some((l) => !l.notes.length)) throw damaged();
  return {
    bpm: num(c.bpm, 20, 400), duration, tuning: c.tuning == null ? 0 : num(c.tuning, -1, 1), language,
    version: c.version == null ? 0 : num(c.version, 0, 1e6), lines,
  };
}

/** @param {Blob} blob @param {string} from who sent it @param {string} id the song asked for @returns {Promise<SongRecord>} */
export async function unpackSong(blob, from, id) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw damaged();
  const len = new DataView(bytes.buffer).getUint32(4);
  if (8 + len > bytes.length) throw damaged();
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  if (header?.id !== id || !/^[a-z0-9-]{1,40}$/.test(id)) throw damaged();
  const accents = arr(header.accents, 2);
  if (accents.length !== 2 || !accents.every((c) => COLOUR.test(c))) throw damaged();
  const parts = arr(header.parts, 3);
  if (new Set(parts.map((p) => p?.name)).size !== 3 || !parts.every((p) => PART_TYPES[/** @type {'inst'} */ (p?.name)]?.test(p.type))) throw damaged();
  let o = 8 + len;
  /** @type {Record<string, Blob>} */
  const part = {};
  for (const p of parts) {
    const size = num(p.size, 0, bytes.length - o);
    part[p.name] = new Blob([bytes.subarray(o, o + size)], { type: p.type });
    o += size;
  }
  return {
    id, title: [...String(header.title || 'Song')].slice(0, 60).join(''), artist: [...String(header.artist || '')].slice(0, 40).join(''),
    createdAt: Date.now(), where: 'friend', from, accents: /** @type {[string, string]} */ (accents), chart: cleanChart(header.chart),
    inst: part.inst, vocals: part.vocals, cover: part.cover,
  };
}
