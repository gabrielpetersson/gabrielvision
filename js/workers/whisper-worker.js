// Speech model for the lyric check: Whisper base in the browser via transformers.js.
// Built-in songs use the English-only model; uploaded songs reuse the multilingual model the importer
// already downloaded, told which language to expect.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
let asr = null;
let language = null;

async function load(lang) {
  language = lang;
  const english = !lang;
  const progress = (p) => {
    if (p.status === 'progress' && p.total) postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  };
  asr = await pipeline('automatic-speech-recognition', english ? 'onnx-community/whisper-base.en' : 'onnx-community/whisper-base_timestamped', {
    device: 'wasm',
    dtype: english ? 'q8' : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: progress,
  });
  // Warm up so the first real line is not slow.
  await asr(new Float32Array(16000), english ? {} : { language, task: 'transcribe' });
  postMessage({ type: 'ready', device: 'wasm' });
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      if (!asr) await load(msg.language);
      else postMessage({ type: 'ready' });
    } else if (msg.type === 'transcribe') {
      // A sung line is short: cap the output and block repeated phrases so the model can't loop.
      const opts = { max_new_tokens: 40, no_repeat_ngram_size: 3 };
      if (language) Object.assign(opts, { language, task: 'transcribe' });
      const out = await asr(msg.audio, opts);
      postMessage({ type: 'text', id: msg.id, text: out.text || '' });
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
