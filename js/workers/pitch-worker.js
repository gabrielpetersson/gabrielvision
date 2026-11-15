// Pitch of the separated vocal, every 10 ms: FCPE (a small pitch network, in ONNX Runtime Web) says which note is sung,
// YIN's clarity says whether anything is sung at all (FCPE keeps "hearing" a voice through reverb tails).
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
import { Yin } from '../pitch.js';
import { logMel, decodeF0, FCPE } from '../import/fcpe.js';
import { cachedModel } from '../import/model-cache.js';

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
const HOP = FCPE.hop;
// Below this YIN clarity a frame counts as not sung (the best setting on test songs whose notes are known).
const SUNG_CLARITY = 0.5;

const post = (stage, value) => postMessage({ type: 'progress', stage, value });

// YIN clarity and loudness per 10 ms frame (frame i centred at i * 10 ms).
function yinFrames(audio) {
  const size = 1024, yin = new Yin(FCPE.rate, size);
  const n = Math.floor(audio.length / HOP);
  const clarity = new Float32Array(n), rms = new Float32Array(n);
  const win = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    const start = i * HOP - size / 2;
    for (let j = 0; j < size; j++) {
      const k = start + j;
      win[j] = k >= 0 && k < audio.length ? audio[k] : 0;
    }
    const r = yin.detect(win);
    clarity[i] = r.clarity;
    rms[i] = r.rms;
    if (i % 2000 === 0) post('pitch', (0.5 * i) / n);
  }
  return { clarity, rms };
}

onmessage = async (e) => {
  const { audio, modelUrl, device } = e.data;
  try {
    const bytes = await cachedModel(modelUrl, (p) => post('pitch-model', p));
    const { clarity, rms } = yinFrames(audio);
    const mel = logMel(audio);
    post('pitch', 0.7);
    // The network looks across the whole song, so it runs on all of it at once (its attention is linear in length).
    // A 3-minute song takes about 0.1 s on WebGPU and 9 s on the CPU.
    const session = await ort.InferenceSession.create(bytes, { executionProviders: device === 'webgpu' ? ['webgpu'] : ['wasm'] });
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', mel.data, [1, mel.frames, FCPE.mels]) });
    const latent = await out[session.outputNames[0]].getData();
    await session.release();
    const f0 = decodeF0(latent, mel.frames);
    const hz = new Float32Array(clarity.length);
    for (let i = 0; i < hz.length; i++) hz[i] = clarity[i] >= SUNG_CLARITY ? f0[i] : 0;
    post('pitch', 1);
    postMessage({ type: 'done', pitch: { hop: HOP / FCPE.rate, hz, rms } }, [hz.buffer, rms.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
