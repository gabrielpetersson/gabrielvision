// @ts-check
// Turns any audio or video file into a playable song: music and voice tracks, words and note bars, all on this
// device. The heavy steps run in workers, on the GPU when the browser offers WebGPU.

import { buildChart } from './chart-builder.js';
import { estimateTempo } from './tempo.js';
import { encodeWav } from './wav.js';
import { readTags } from './tags.js';
import { accentsFor, makeCover, coverFromTag } from './art.js';
import { vocalRegions } from './regions.js';
import { IMPORT_VERSION } from '../songs.js';

const RATE = 44100;
const MODEL_URL = new URL('../../models/Kim_Vocal_2.onnx', import.meta.url).href;
const PITCH_MODEL_URL = new URL('../../models/fcpe.onnx', import.meta.url).href;
const MAX_SECONDS = 10 * 60;

/** The GPU, if this browser offers one: f16 says whether it runs half-precision shaders (the GPU speech model needs
 * them). @returns {Promise<{ f16: boolean } | null>} */
export async function gpuInfo() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter ? { f16: adapter.features.has('shader-f16') } : null;
  } catch {
    return null;
  }
}

/** The file's length from its metadata, before decoding it (a two-hour file would fill memory). null when the browser
 * can't tell. @param {File} file @returns {Promise<number | null>} */
function mediaDuration(file) {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    const done = (/** @type {number | null} */ d) => { clearTimeout(timer); URL.revokeObjectURL(url); el.removeAttribute('src'); resolve(d); };
    const timer = setTimeout(() => done(null), 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/** Decodes with the browser first; formats it can't open (mkv, avi, wma, …) go through ffmpeg.wasm.
 * @param {File} file @param {(p: number) => void} onProgress @param {AbortSignal} signal */
export async function decodeFile(file, onProgress, signal) {
  const ctx = new OfflineAudioContext(2, 1, RATE);
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    const { extractAudio } = await import('./ffmpeg.js');
    return ctx.decodeAudioData(await extractAudio(file, onProgress, signal));
  }
}

/** @param {AudioBuffer} buffer */
export function stereo(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return [left, right];
}

const cancelled = () => new DOMException('Cancelled', 'AbortError');

/** @param {URL} url @param {any} message @param {Transferable[]} transfer @param {(stage: string, p: number) => void} onProgress
 * @param {AbortSignal} signal @returns {Promise<any>} */
function runWorker(url, message, transfer, onProgress, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  const w = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    const stop = () => { w.terminate(); reject(cancelled()); };
    signal.addEventListener('abort', stop, { once: true });
    const end = () => { w.terminate(); signal.removeEventListener('abort', stop); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.stage, m.value);
      else if (m.type === 'done') { end(); resolve(m); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { end(); reject(new Error(e.message || 'Worker failed')); };
    w.postMessage(message, transfer);
  });
}

/** @param {Float32Array} left @param {Float32Array} right @param {string} device
 * @param {(stage: string, p: number) => void} onProgress @param {AbortSignal} signal */
export async function separateOnDevice(left, right, device, onProgress, signal) {
  const l = left.slice(), r = right.slice();
  const res = await runWorker(new URL('../workers/separate-worker.js', import.meta.url), { left: l, right: r, modelUrl: MODEL_URL, device }, [l.buffer, r.buffer], onProgress, signal);
  return { left: /** @type {Float32Array<ArrayBuffer>} */ (res.left), right: /** @type {Float32Array<ArrayBuffer>} */ (res.right) };
}

/** The sung note every 10 ms: { hop, hz (0 = not sung), rms }.
 * @param {Float32Array} vocal16k @param {string} device @param {(stage: string, p: number) => void} onProgress @param {AbortSignal} signal */
export async function trackPitch(vocal16k, device, onProgress, signal) {
  const audio = vocal16k.slice();
  return (await runWorker(new URL('../workers/pitch-worker.js', import.meta.url), { audio, modelUrl: PITCH_MODEL_URL, device }, [audio.buffer], onProgress, signal)).pitch;
}

/** The sung words with timings, and the language, from the regions where someone sings.
 * @param {Float32Array} vocal16k @param {string} device @param {{ regions: { start: number, end: number }[], language?: string }} o
 * @param {(stage: string, p: number) => void} onProgress @param {AbortSignal} signal */
export function readWords(vocal16k, device, { regions, language }, onProgress, signal) {
  const audio = vocal16k.slice();
  return runWorker(new URL('../workers/transcribe-worker.js', import.meta.url), { audio, device, regions, language }, [audio.buffer], onProgress, signal);
}

/** Native resampling: any channels at any rate to mono at `rate`. @param {Float32Array<ArrayBuffer>[]} channels @param {number} rate */
export async function resample(channels, rate, inRate = RATE) {
  const len = channels[0].length;
  const src = new AudioBuffer({ numberOfChannels: channels.length, length: len, sampleRate: inRate });
  channels.forEach((c, i) => src.copyToChannel(c, i));
  const ctx = new OfflineAudioContext(1, Math.ceil((len * rate) / inRate), rate);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination);
  node.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/** The whole pipeline. stage(name, progress 0..1) drives the progress screen: read, model, separate, pitch-model,
 * pitch, lyrics-model, words, notes. Every await checks the signal, so a cancelled upload never comes back as a song.
 * @param {File} file @param {{ lyrics: string, signal: AbortSignal, stage: (name: string, p: number) => void }} o
 * @returns {Promise<SongRecord & { where: 'device' | 'device-cpu' }>} */
export async function importSong(file, { lyrics, signal, stage }) {
  stage('read', 0);
  const length = await mediaDuration(file);
  if (length != null && length > MAX_SECONDS) throw new Error(`That file is ${Math.round(length / 60)} minutes long. Songs up to ${MAX_SECONDS / 60} minutes work.`);
  const [buffer, tags] = await Promise.all([decodeFile(file, (p) => stage('read', p), signal), readTags(file).catch(() => /** @type {Awaited<ReturnType<typeof readTags>>} */ ({}))]);
  signal.throwIfAborted();
  if (buffer.duration > MAX_SECONDS) throw new Error(`That file is ${Math.round(buffer.duration / 60)} minutes long. Songs up to ${MAX_SECONDS / 60} minutes work.`);
  if (buffer.duration < 10) throw new Error('That file is shorter than 10 seconds.');
  const [left, right] = stereo(buffer);
  stage('read', 1);

  const gpu = await gpuInfo();
  const device = gpu ? 'webgpu' : 'wasm';
  const vocals = await separateOnDevice(left, right, device, stage, signal);

  const inst = [new Float32Array(left.length), new Float32Array(left.length)];
  for (let i = 0; i < left.length; i++) {
    inst[0][i] = left[i] - vocals.left[i];
    inst[1][i] = right[i] - vocals.right[i];
  }
  const [vocal16k, inst11k] = await Promise.all([resample([vocals.left, vocals.right], 16000), resample(inst, 11025)]);
  signal.throwIfAborted();
  const pitch = await trackPitch(vocal16k, device, stage, signal);
  const { words, language } = await readWords(vocal16k, gpu?.f16 ? 'webgpu' : 'wasm', { regions: vocalRegions(pitch.rms, pitch.hop) }, (s, p) => stage(s === 'model' ? 'lyrics-model' : s, p), signal);

  stage('notes', 0);
  const tempo = estimateTempo(inst11k, 11025);
  const title = tags.title || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My song';
  const artist = tags.artist || '';
  const chart = /** @type {Chart} */ (buildChart({ pitch, words, lyrics, duration: buffer.duration, tempo, title, artist, language }));
  if (chart.lines.length < 2) throw new Error('No singing found in that file. Try a song with vocals.');
  stage('notes', 1);

  const accents = accentsFor(title);
  // A picture in the file's tag that isn't one the browser can open gets a made cover instead.
  const cover = (tags.cover && (await coverFromTag(tags.cover).catch(() => null))) || (await makeCover(title, artist, accents));
  signal.throwIfAborted();
  const id = `u${Date.now().toString(36)}`;
  chart.version = IMPORT_VERSION;
  return {
    id,
    title,
    artist,
    createdAt: Date.now(),
    where: gpu ? 'device' : 'device-cpu',
    accents,
    chart,
    inst: encodeWav(inst, RATE),
    vocals: encodeWav([vocals.left.map((x, i) => (x + vocals.right[i]) / 2)], RATE),
    cover,
    // The uploaded file itself, so a newer importer can remake the song later.
    source: file,
  };
}
