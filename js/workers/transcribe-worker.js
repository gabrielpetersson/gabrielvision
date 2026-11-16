// Writes down the sung words of the separated vocal on this device, with timings (Whisper), region by region.
const RATE = 16000;
// With a GPU, Whisper large-v3-turbo in 4-bit (about 560 MB, downloaded once) hears sung words far better than base:
// on a pop verse base got a quarter of the words wrong. Without one, turbo would take minutes, so the CPU keeps base
// in 8-bit (77 MB; base's fp16 GPU build returns garbage).
// Each model runs on the transformers.js release it was measured with: 3.8 drops whole sung stretches with turbo, and
// base on 4.3 loops on spoken and noisy stretches ("-N -U -N -A…"). Base also may not repeat a four-word phrase within a
// stretch (it loops on held notes); turbo doesn't loop, and that ban would cut real repeats in a chorus.
const MODELS = {
  webgpu: {
    lib: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2',
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' },
    generate: {},
  },
  wasm: {
    lib: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1',
    id: 'onnx-community/whisper-base_timestamped',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    generate: { no_repeat_ngram_size: 4 },
  },
};

const post = (stage, value) => postMessage({ type: 'progress', stage, value });

async function loadAsr({ pipeline }, device) {
  const files = new Map();
  const { id, dtype } = MODELS[device];
  return pipeline('automatic-speech-recognition', id, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, p);
      const all = [...files.values()];
      post('model', all.reduce((s, f) => s + f.loaded, 0) / all.reduce((s, f) => s + f.total, 0));
    },
  });
}

// Whisper in transformers.js has no language detection: score the language tokens (the model's own lang_to_id table)
// right after <|startoftranscript|>.
async function detectLanguage({ Tensor }, asr, audio) {
  const { decoder_start_token_id: sot, lang_to_id } = asr.model.generation_config;
  const { input_features } = await asr.processor(audio);
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', [BigInt(sot)], [1, 1]) });
  const logits = out.logits.data;
  const vocab = out.logits.dims.at(-1);
  let best = -Infinity, code = 'en';
  for (const [token, id] of Object.entries(lang_to_id)) {
    const v = logits[logits.length - vocab + id];
    if (v > best) { best = v; code = token.slice(2, -2); }
  }
  return code;
}

onmessage = async (e) => {
  const { audio, device, regions, language: forced } = e.data;
  try {
    const lib = await import(MODELS[device].lib);
    lib.env.allowLocalModels = false;
    const asr = await loadAsr(lib, device);
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
    const language = forced || (await detectLanguage(lib, asr, sample.subarray(0, Math.max(o, RATE))));
    const words = [];
    for (const [i, r] of regions.entries()) {
      const part = audio.slice(Math.floor(r.start * RATE), Math.floor(r.end * RATE));
      const out = await asr(part, { language, task: 'transcribe', return_timestamps: 'word', ...MODELS[device].generate });
      for (const c of out.chunks || []) {
        const [s, en] = c.timestamp;
        const text = c.text.trim();
        if (!text) continue;
        words.push({ text, start: r.start + s, end: r.start + (en ?? s + 0.3) });
      }
      post('words', (i + 1) / regions.length);
    }
    postMessage({ type: 'done', language, words });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
