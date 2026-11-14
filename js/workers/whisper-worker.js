// Speech model for the lyric check: Whisper (English, base) running in the browser via transformers.js.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
const MODEL = 'onnx-community/whisper-base.en';
let asr = null;

async function load() {
  const device = 'wasm';
  const progress = (p) => {
    if (p.status === 'progress' && p.total) postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  };
  asr = await pipeline('automatic-speech-recognition', MODEL, {
    device,
    dtype: 'q8',
    progress_callback: progress,
  });
  // Warm up so the first real line is not slow.
  await asr(new Float32Array(16000));
  postMessage({ type: 'ready', device });
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      if (!asr) await load();
      else postMessage({ type: 'ready' });
    } else if (msg.type === 'transcribe') {
      // A sung line is short: cap the output and block repeated phrases so the model can't loop.
      const out = await asr(msg.audio, { max_new_tokens: 40, no_repeat_ngram_size: 3 });
      postMessage({ type: 'text', id: msg.id, text: out.text || '' });
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
