// Splits a song into voice and music on this device: MDX-Net (Kim Vocal 2) in ONNX Runtime Web.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
import { MdxSeparator, MDX } from '../import/mdx.js';
import { cachedModel } from '../import/model-cache.js';

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

onmessage = async (e) => {
  const { left, right, modelUrl, device } = e.data;
  try {
    const bytes = await cachedModel(modelUrl, (p) => postMessage({ type: 'progress', stage: 'model', value: p }));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: device === 'webgpu' ? ['webgpu'] : ['wasm'] });
    const shape = [1, 4, MDX.dimF, MDX.dimT];
    const sep = new MdxSeparator(async (input) => {
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, shape) });
      const t = out[session.outputNames[0]];
      const data = await t.getData();
      t.dispose?.();
      return data;
    });
    const t0 = performance.now();
    const vocals = await sep.separate(left, right, (p) => postMessage({ type: 'progress', stage: 'separate', value: p }));
    await session.release();
    postMessage({ type: 'done', left: vocals.left, right: vocals.right, ms: performance.now() - t0 }, [vocals.left.buffer, vocals.right.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
