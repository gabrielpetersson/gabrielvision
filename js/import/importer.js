// Turns any audio or video file into a playable song: music and voice tracks, lyrics, and note bars.
// The heavy steps run in workers on this device's GPU, or on the server when the device has no WebGPU.

import { buildChart } from './chart-builder.js';
import { estimateTempo } from './tempo.js';
import { encodeWav } from './wav.js';
import { readTags } from './tags.js';
import { accentsFor, makeCover, makeStage } from './art.js';

const RATE = 44100;
const MODEL_URL = new URL('../../models/Kim_Vocal_2.onnx', import.meta.url).href;
const MAX_SECONDS = 10 * 60;

// 'webgpu' when this browser can run the models on the GPU, else null.
export async function gpuDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    return adapter ? 'webgpu' : null;
  } catch {
    return null;
  }
}

// Decodes with the browser first; formats it can't open (mkv, avi, wma, …) go through ffmpeg.wasm.
export async function decodeFile(file, onProgress, signal) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, RATE);
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    const { extractAudio } = await import('./ffmpeg.js');
    const wav = await extractAudio(file, onProgress, signal);
    return ctx.decodeAudioData(wav);
  }
}

export function stereo(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return [left, right];
}

const cancelled = () => new DOMException('Cancelled', 'AbortError');

function runWorker(url, message, transfer, onProgress, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  const w = new Worker(url, { type: 'module' });
  return new Promise((resolve, reject) => {
    const stop = () => { w.terminate(); reject(cancelled()); };
    signal?.addEventListener('abort', stop, { once: true });
    const end = () => { w.terminate(); signal?.removeEventListener('abort', stop); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.stage, m.value);
      else if (m.type === 'done') { end(); resolve(m); }
      else if (m.type === 'error') { end(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { end(); reject(new Error(e.message || 'Worker failed')); };
    w.postMessage(message, transfer);
  });
}

export async function separateOnDevice(left, right, device, onProgress, signal) {
  const l = left.slice(), r = right.slice();
  const res = await runWorker(new URL('../workers/separate-worker.js', import.meta.url), { left: l, right: r, modelUrl: MODEL_URL, device }, [l.buffer, r.buffer], onProgress, signal);
  return { left: res.left, right: res.right };
}

// Pitch every 10 ms, plus words and language unless the server sent them already.
export function readVocal(vocal16k, { words, language }, onProgress, signal) {
  const audio = vocal16k.slice();
  return runWorker(new URL('../workers/transcribe-worker.js', import.meta.url), { audio, words, language }, [audio.buffer], onProgress, signal);
}

// Native resampling: any channels at any rate to mono at `rate`.
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

// The whole pipeline. stage(name, progress 0..1) drives the progress screen:
// read, download (voice model), separate, upload/server, lyrics-model, lyrics, notes, save.
export async function importSong(file, { lyrics = '', server, signal, stage = () => {} }) {
  stage('read', 0);
  const [buffer, tags] = await Promise.all([decodeFile(file, (p) => stage('read', p), signal), readTags(file).catch(() => ({}))]);
  if (buffer.duration > MAX_SECONDS) throw new Error(`That file is ${Math.round(buffer.duration / 60)} minutes long. Songs up to ${MAX_SECONDS / 60} minutes work.`);
  if (buffer.duration < 10) throw new Error('That file is shorter than 10 seconds.');
  const [left, right] = stereo(buffer);
  stage('read', 1);

  const device = await gpuDevice();
  let vocals, words, language, where;
  if (device || !server) {
    where = device ? 'device' : 'device-cpu';
    stage('separate', 0);
    vocals = await separateOnDevice(left, right, device || 'wasm', (s, p) => stage(s === 'model' ? 'download' : 'separate', p), signal);
  } else {
    where = 'server';
    ({ vocals, words, language } = await server.process(file, left.length, stage, signal));
  }
  stage('separate', 1);

  const inst = [new Float32Array(left.length), new Float32Array(left.length)];
  for (let i = 0; i < left.length; i++) {
    inst[0][i] = left[i] - vocals.left[i];
    inst[1][i] = right[i] - vocals.right[i];
  }
  const [vocal16k, inst11k] = await Promise.all([resample([vocals.left, vocals.right], 16000), resample(inst, 11025)]);
  stage('lyrics', 0);
  const read = await readVocal(vocal16k, { words, language }, (s, p) => stage(s === 'model' ? 'lyrics-model' : s, p), signal);
  stage('lyrics', 1);

  stage('notes', 0);
  const tempo = estimateTempo(inst11k, 11025);
  const title = tags.title || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My song';
  const artist = tags.artist || '';
  const chart = buildChart({ pitch: read.pitch, words: read.words, lyrics, duration: buffer.duration, tempo, title, artist, language: read.language });
  if (chart.lines.length < 2) throw new Error('No singing found in that file. Try a song with vocals.');
  stage('notes', 1);

  stage('save', 0);
  const accents = accentsFor(title);
  const cover = tags.cover || (await makeCover(title, artist, accents));
  const id = `u${Date.now().toString(36)}`;
  chart.id = id;
  return {
    id,
    title,
    artist,
    createdAt: Date.now(),
    where,
    accents,
    chart,
    inst: encodeWav(inst, RATE),
    vocals: encodeWav([vocals.left.map((x, i) => (x + vocals.right[i]) / 2)], RATE),
    cover,
    stage: await makeStage(cover, accents),
  };
}
