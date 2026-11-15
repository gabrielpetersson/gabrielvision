// The processing server (server/app.py) for browsers without WebGPU: it separates the voice and writes
// down the words; this browser still finds the notes and lines. null until a server is deployed.
const BASE = null;

async function processOnServer(file, length, stage, signal) {
  stage('upload', null);
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/process`, { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error(res.status === 413 ? 'That file is too big for the server (200 MB at most).' : `The server said no (${res.status}).`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.error) throw new Error(msg.error);
      if (msg.done) result = msg;
      else stage('server', msg.progress);
    }
  }
  if (!result) throw new Error('The server stopped before it finished.');
  const bytes = Uint8Array.from(atob(result.vocals), (c) => c.charCodeAt(0));
  const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes.buffer);
  // Same length as the decoded upload, so the music track is the upload minus this voice.
  const fit = (ch) => {
    const out = new Float32Array(length);
    out.set(decoded.getChannelData(Math.min(ch, decoded.numberOfChannels - 1)).subarray(0, length));
    return out;
  };
  return { vocals: { left: fit(0), right: fit(1) }, words: result.words, language: result.language };
}

export const SERVER = BASE ? { process: processOnServer } : null;
