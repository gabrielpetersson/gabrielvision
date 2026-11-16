// @ts-check
// Fallback decoder: runs ffmpeg.wasm in a worker and returns a WAV the browser can decode.

/** @param {File} file @param {(p: number) => void} onProgress @param {AbortSignal} signal @returns {Promise<ArrayBuffer>} */
export async function extractAudio(file, onProgress, signal) {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const w = new Worker(new URL('../workers/ffmpeg-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const stop = () => { w.terminate(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', stop, { once: true });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') return onProgress(m.value);
      w.terminate();
      signal.removeEventListener('abort', stop);
      m.type === 'done' ? resolve(m.wav) : reject(new Error(`Couldn't read that file: ${m.message}`));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Could not start the file reader')); };
    w.postMessage({ bytes, ext }, [bytes]);
  });
}
