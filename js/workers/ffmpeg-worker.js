// Pulls the audio out of any file the browser can't decode itself (mkv, avi, wmv, wma, …) with ffmpeg.wasm.
const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';

onmessage = async (e) => {
  const { bytes, ext } = e.data;
  try {
    const createFFmpegCore = (await import(CORE)).default;
    // The core finds its .wasm through JSON in the script URL's hash.
    const ffmpeg = await createFFmpegCore({ mainScriptUrlOrBlob: `${CORE}#${btoa(JSON.stringify({ wasmURL: CORE.replace(/\.js$/, '.wasm'), workerURL: '' }))}` });
    ffmpeg.setProgress(({ progress }) => postMessage({ type: 'progress', value: Math.max(0, Math.min(1, progress)) }));
    const input = `in.${ext || 'bin'}`;
    ffmpeg.FS.writeFile(input, new Uint8Array(bytes));
    ffmpeg.exec('-i', input, '-vn', '-ac', '2', '-ar', '44100', '-f', 'wav', 'out.wav');
    if (ffmpeg.ret !== 0) throw new Error("This file has no audio we can read.");
    const out = ffmpeg.FS.readFile('out.wav');
    postMessage({ type: 'done', wav: out.buffer }, [out.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
