// Reads the separated vocal on this device: pitch every 10 ms (YIN) and the sung words with timings (Whisper).
import { pipeline, env, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { Yin } from '../pitch.js';
import { vocalRegions } from '../import/regions.js';

env.allowLocalModels = false;
const MODEL = 'onnx-community/whisper-base_timestamped';
const RATE = 16000;
const HOP = 160;

const post = (stage, value) => postMessage({ type: 'progress', stage, value });

// YIN over the whole vocal: Float32Arrays of hz, clarity and rms per 10 ms hop (frame centre at i * 10 ms).
function trackPitch(audio) {
  const size = 1024, yin = new Yin(RATE, size);
  const n = Math.floor(audio.length / HOP);
  const hz = new Float32Array(n), clarity = new Float32Array(n), rms = new Float32Array(n);
  const win = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    const start = i * HOP - size / 2;
    for (let j = 0; j < size; j++) {
      const k = start + j;
      win[j] = k >= 0 && k < audio.length ? audio[k] : 0;
    }
    const r = yin.detect(win);
    hz[i] = r.hz; clarity[i] = r.clarity; rms[i] = r.rms;
    if (i % 2000 === 0) post('pitch', i / n);
  }
  return { hz, clarity, rms, hop: HOP / RATE };
}

// Whisper runs on the CPU in 8-bit: the GPU builds of this model either return garbage (fp16) or need a
// 206 MB download (fp32), while int8 on WebAssembly is a 77 MB download and takes seconds per sung region.
async function loadAsr() {
  const files = new Map();
  return pipeline('automatic-speech-recognition', MODEL, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, p);
      const all = [...files.values()];
      post('model', all.reduce((s, f) => s + f.loaded, 0) / all.reduce((s, f) => s + f.total, 0));
    },
  });
}

// Whisper in transformers.js has no language detection: score the language tokens after <|startoftranscript|>.
async function detectLanguage(asr, audio) {
  const tok = asr.tokenizer;
  const sot = tok.model.tokens_to_ids.get('<|startoftranscript|>');
  const translate = tok.model.tokens_to_ids.get('<|translate|>');
  const { input_features } = await asr.processor(audio);
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', [BigInt(sot)], [1, 1]) });
  const logits = out.logits.data;
  const vocab = out.logits.dims.at(-1);
  let best = -Infinity, code = 'en';
  for (let id = sot + 1; id < translate; id++) {
    const v = logits[logits.length - vocab + id];
    if (v > best) { best = v; code = tok.model.vocab[id].slice(2, -2); }
  }
  return code;
}

onmessage = async (e) => {
  const { audio, words: given, language: forced } = e.data;
  try {
    const pitch = trackPitch(audio);
    post('pitch', 1);
    const regions = vocalRegions(pitch.rms, pitch.hop);
    const transfer = [pitch.hz.buffer, pitch.clarity.buffer, pitch.rms.buffer];
    // The server already wrote down the words.
    if (given) return postMessage({ type: 'done', language: forced, words: given, regions, pitch }, transfer);
    const asr = await loadAsr();
    post('words', 0);
    // Detect the language on the regions with the most singing (first 30 s of them).
    const sample = new Float32Array(30 * RATE);
    let o = 0;
    for (const r of regions) {
      if (o >= sample.length) break;
      const part = audio.subarray(Math.floor(r.start * RATE), Math.floor(r.end * RATE)).subarray(0, sample.length - o);
      sample.set(part, o);
      o += part.length;
    }
    const language = forced || (await detectLanguage(asr, sample.subarray(0, Math.max(o, RATE))));
    const words = [];
    for (const [i, r] of regions.entries()) {
      const part = audio.slice(Math.floor(r.start * RATE), Math.floor(r.end * RATE));
      const out = await asr(part, { language, task: 'transcribe', return_timestamps: 'word', no_repeat_ngram_size: 4 });
      for (const c of out.chunks || []) {
        const [s, en] = c.timestamp;
        const text = c.text.trim();
        if (!text) continue;
        words.push({ text, start: r.start + s, end: r.start + (en ?? s + 0.3) });
      }
      post('words', (i + 1) / regions.length);
    }
    postMessage({ type: 'done', language, words, regions, pitch }, transfer);
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
